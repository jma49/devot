//! On-device sentence embeddings from the NaturalLanguage framework (`semantic`), the same on
//! macOS and iOS. Each model is loaded once per thread that asks and kept; a language without one
//! gives `None`, and the caller falls back to another.

use std::collections::HashMap;
use std::ptr::NonNull;

use objc2::rc::{Retained, autoreleasepool};
use objc2_foundation::NSString;
use objc2_natural_language::{NLEmbedding, NLLanguageRecognizer};

use crate::native::guarded;

struct Model {
    embedding: Retained<NLEmbedding>,
    dimension: usize,
    revision: usize,
}

/// Not `Send`: it lives on the thread that made it.
#[derive(Default)]
pub(crate) struct SentenceEmbeddings {
    models: HashMap<String, Option<Model>>,
}

impl SentenceEmbeddings {
    fn model(&mut self, language: &str) -> Option<&Model> {
        self.models
            .entry(language.to_owned())
            .or_insert_with(|| {
                guarded("W_EMBED_MODEL", || {
                    autoreleasepool(|_| {
                        let code = NSString::from_str(language);
                        // SAFETY: a class method that takes any language code and answers nil for
                        // one it has no model for.
                        let embedding =
                            unsafe { NLEmbedding::sentenceEmbeddingForLanguage(&code) }?;
                        // SAFETY: plain property reads of a live embedding.
                        let (dimension, revision) =
                            unsafe { (embedding.dimension(), embedding.revision()) };
                        (dimension > 0).then_some(Model {
                            embedding,
                            dimension,
                            revision,
                        })
                    })
                })
            })
            .as_ref()
    }

    /// The model's revision for `language`, or `None` when the system has no model for it.
    pub(crate) fn revision(&mut self, language: &str) -> Option<usize> {
        self.model(language).map(|model| model.revision)
    }

    /// A vector of the model's dimension, or `None` when there is no model or it has no vector
    /// for the text.
    pub(crate) fn vector(&mut self, language: &str, text: &str) -> Option<Vec<f32>> {
        let model = self.model(language)?;
        guarded("W_EMBED_VECTOR", || {
            autoreleasepool(|_| {
                let text = NSString::from_str(text);
                let mut vector = vec![0f32; model.dimension];
                let out = NonNull::new(vector.as_mut_ptr())?;
                // SAFETY: `out` points to `dimension` floats, the length the model writes.
                let found = unsafe { model.embedding.getVector_forString(out, &text) };
                (found && vector.iter().all(|v| v.is_finite())).then_some(vector)
            })
        })
    }
}

/// The BCP 47 code of the text's main language, or `None` when it cannot tell.
pub(crate) fn dominant_language(text: &str) -> Option<String> {
    guarded("W_EMBED_LANGUAGE", || {
        autoreleasepool(|_| {
            let text = NSString::from_str(text);
            // SAFETY: a class method that takes any string and answers nil when it cannot tell.
            let language = unsafe { NLLanguageRecognizer::dominantLanguageForString(&text) }?;
            Some(language.to_string())
        })
    })
}

/// Indexing runs at utility priority, so it gives way to everything the user is doing.
pub(crate) fn lower_thread_priority() {
    // SAFETY: changes the calling thread's own QoS class and nothing else.
    let status =
        unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0) };
    if status != 0 {
        log::warn!("W_EMBED_PRIORITY {status}");
    }
}
