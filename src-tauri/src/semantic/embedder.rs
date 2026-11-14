/// A sentence model. Vectors are compared only with vectors of the same tag.
pub(crate) trait Embedder {
    /// The tag of the model that takes `text` (its language and revision), detected from the
    /// text; `None` when no model takes it.
    fn tag_for(&mut self, text: &str) -> Option<String>;
    /// Whether `tag` is a model this embedder still has, at that revision.
    fn current(&mut self, tag: &str) -> bool;
    fn vector(&mut self, tag: &str, text: &str) -> Option<Vec<f32>>;
}

pub(crate) type MakeEmbedder = Box<dyn FnOnce() -> Option<Box<dyn Embedder>> + Send>;

/// The system's sentence embeddings, on the device.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) mod apple {
    use super::Embedder;
    use crate::native::ios::embedding::{SentenceEmbeddings, dominant_language};

    /// The languages the system has sentence embeddings for; text in another is read with the
    /// first.
    const LANGUAGES: [&str; 7] = ["en", "zh-Hans", "es", "fr", "de", "it", "pt"];

    pub(crate) struct Apple(SentenceEmbeddings);

    pub(crate) fn make() -> Option<Box<dyn Embedder>> {
        let mut models = SentenceEmbeddings::default();
        models.revision(LANGUAGES[0])?;
        Some(Box::new(Apple(models)))
    }

    fn split(tag: &str) -> Option<(&str, usize)> {
        let (language, revision) = tag.split_once('@')?;
        Some((language, revision.parse().ok()?))
    }

    impl Embedder for Apple {
        fn tag_for(&mut self, text: &str) -> Option<String> {
            let detected = dominant_language(text)
                .and_then(|code| LANGUAGES.into_iter().find(|l| *l == code))
                .filter(|&l| self.0.revision(l).is_some());
            let language = detected.unwrap_or(LANGUAGES[0]);
            let revision = self.0.revision(language)?;
            Some(format!("{language}@{revision}"))
        }

        fn current(&mut self, tag: &str) -> bool {
            split(tag).is_some_and(|(language, revision)| {
                LANGUAGES.contains(&language) && self.0.revision(language) == Some(revision)
            })
        }

        fn vector(&mut self, tag: &str, text: &str) -> Option<Vec<f32>> {
            let (language, _) = split(tag)?;
            self.0.vector(language, text)
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn system() -> MakeEmbedder {
    Box::new(apple::make)
}

/// No system model elsewhere: semantic search is unavailable there.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) fn system() -> MakeEmbedder {
    Box::new(|| None)
}

/// Words hashed into a few dimensions: enough to test what is built around a model.
#[cfg(test)]
pub(crate) mod hashed {
    use super::Embedder;
    use std::sync::{Arc, Mutex};

    pub(crate) const DIMENSION: usize = 4096;

    #[derive(Clone, Default)]
    pub(crate) struct Hashed {
        pub revision: Arc<Mutex<u32>>,
        pub embedded: Arc<Mutex<Vec<String>>>,
    }

    fn slot(word: &str) -> usize {
        word.bytes().fold(2166136261u32, |h, b| {
            (h ^ u32::from(b)).wrapping_mul(16777619)
        }) as usize
            % DIMENSION
    }

    impl Embedder for Hashed {
        fn tag_for(&mut self, _text: &str) -> Option<String> {
            Some(format!("test@{}", self.revision.lock().unwrap()))
        }

        fn current(&mut self, tag: &str) -> bool {
            tag == format!("test@{}", self.revision.lock().unwrap())
        }

        fn vector(&mut self, _tag: &str, text: &str) -> Option<Vec<f32>> {
            self.embedded.lock().unwrap().push(text.to_owned());
            let mut vector = vec![0f32; DIMENSION];
            for word in text
                .split(|c: char| !c.is_alphanumeric())
                .filter(|w| !w.is_empty())
            {
                vector[slot(&word.to_lowercase())] += 1.0;
            }
            vector.iter().any(|v| *v != 0.0).then_some(vector)
        }
    }
}
