//! Properties of loading a JSON store file that may be torn or damaged.

use owncord_parse::store::parse_map;
use proptest::prelude::*;
use serde_json::{Map, Value};

fn leaf() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(Value::from),
        "\\PC{0,16}".prop_map(Value::String),
    ]
}

fn value() -> impl Strategy<Value = Value> {
    leaf().prop_recursive(4, 32, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
            prop::collection::btree_map("\\PC{0,8}", inner, 0..6)
                .prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
}

fn store() -> impl Strategy<Value = Map<String, Value>> {
    prop::collection::btree_map("\\PC{0,12}", value(), 0..8).prop_map(|m| m.into_iter().collect())
}

proptest! {
    #[test]
    fn a_saved_store_loads_back_unchanged(map in store(), pretty in any::<bool>()) {
        let bytes = if pretty {
            serde_json::to_vec_pretty(&map)
        } else {
            serde_json::to_vec(&map)
        };
        let bytes = bytes.map_err(|e| TestCaseError::fail(e.to_string()))?;
        prop_assert_eq!(parse_map(&bytes), Ok(map));
    }

    #[test]
    fn a_torn_store_file_is_an_error(map in store(), cut in any::<prop::sample::Index>()) {
        let bytes = serde_json::to_vec(&map).map_err(|e| TestCaseError::fail(e.to_string()))?;
        let torn = &bytes[..cut.index(bytes.len())];
        prop_assert!(parse_map(torn).is_err());
    }

    #[test]
    fn a_store_file_that_is_not_an_object_is_an_error(
        v in prop_oneof![leaf(), prop::collection::vec(value(), 0..6).prop_map(Value::Array)],
    ) {
        let bytes = serde_json::to_vec(&v).map_err(|e| TestCaseError::fail(e.to_string()))?;
        prop_assert!(parse_map(&bytes).is_err());
    }

    #[test]
    fn arbitrary_bytes_never_panic_and_only_an_object_loads(raw in prop::collection::vec(any::<u8>(), 0..512)) {
        if parse_map(&raw).is_ok() {
            let parsed: Result<Value, _> = serde_json::from_slice(&raw);
            prop_assert!(matches!(parsed, Ok(Value::Object(_))));
        }
    }

    #[test]
    fn deep_nesting_is_an_error_not_a_stack_overflow(depth in 129usize..20_000, object in any::<bool>()) {
        let (open, close) = if object { ("{\"a\":", "}") } else { ("[", "]") };
        let text = format!("{{\"k\":{}1{}}}", open.repeat(depth), close.repeat(depth));
        prop_assert!(parse_map(text.as_bytes()).is_err());
    }
}
