//! The text in an image, read by the Vision framework on the device (`image_text`), the same on
//! macOS and iOS. Lines come in the order Vision gives them, its best candidate for each.

use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyObject, NSObjectProtocol};
use objc2::{AnyThread, sel};
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{
    VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
    VNRequestTextRecognitionLevel,
};

use crate::image_text::Reader;
use crate::native::guarded;

pub(crate) struct Recognizer;

impl Reader for Recognizer {
    fn read(&mut self, image: &[u8]) -> Result<String, &'static str> {
        guarded("W_IMAGE_TEXT_VISION", || Some(recognize(image)))
            .unwrap_or(Err("E_IMAGE_TEXT_NATIVE"))
    }
}

fn recognize(image: &[u8]) -> Result<String, &'static str> {
    autoreleasepool(|_| {
        let data = NSData::with_bytes(image);
        let options = NSDictionary::<VNImageOption, AnyObject>::new();
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &options,
        );
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        if request.respondsToSelector(sel!(setAutomaticallyDetectsLanguage:)) {
            request.setAutomaticallyDetectsLanguage(true);
        } else {
            let languages = NSArray::from_retained_slice(&[
                NSString::from_str("zh-Hans"),
                NSString::from_str("en-US"),
            ]);
            request.setRecognitionLanguages(&languages);
        }
        let requests = NSArray::<VNRequest>::from_slice(&[&request]);
        handler
            .performRequests_error(&requests)
            .map_err(|_| "E_IMAGE_TEXT_UNREADABLE")?;
        let lines: Vec<String> = request
            .results()
            .map(|observations| {
                observations
                    .iter()
                    .filter_map(|observation| {
                        observation
                            .topCandidates(1)
                            .firstObject()
                            .map(|candidate| candidate.string().to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(lines.join("\n"))
    })
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn reads_the_words_in_a_picture_of_text() {
        let image = include_bytes!("../../../tests/fixtures/image-text.png");
        let text = Recognizer.read(image).unwrap().to_lowercase();
        assert!(text.contains("invoice"), "read {} chars", text.len());
        assert!(text.contains("4471"));
    }

    #[test]
    fn bytes_that_are_no_image_give_a_code() {
        assert!(Recognizer.read(b"not an image").is_err());
    }
}
