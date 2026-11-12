//! Parsing of the client's JSON store files, which may be torn or damaged.

use serde_json::{Map, Value};

pub fn parse_map(bytes: &[u8]) -> Result<Map<String, Value>, String> {
    match serde_json::from_slice(bytes) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err("not a JSON object".into()),
        Err(e) => Err(e.to_string()),
    }
}
