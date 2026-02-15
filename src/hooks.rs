use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookInput {
    pub session_id: String,
    pub transcript_path: String,
    pub cwd: String,
    pub permission_mode: String,
    pub hook_event_name: String,
    #[serde(default)]
    pub notification_text: Option<String>,
    #[serde(default)]
    pub final_response: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_input: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continue_exec: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_message: Option<String>,
}

impl HookOutput {
    pub fn success() -> Self {
        HookOutput {
            continue_exec: Some(true),
            stop_reason: None,
            system_message: None,
        }
    }

    pub fn block(reason: String) -> Self {
        HookOutput {
            continue_exec: Some(false),
            stop_reason: Some(reason),
            system_message: None,
        }
    }
}

pub fn read_hook_input() -> Result<HookInput, anyhow::Error> {
    let stdin = io::stdin();
    let mut input = String::new();
    
    for line in stdin.lock().lines() {
        let line = line?;
        input.push_str(&line);
    }
    
    let hook_input: HookInput = serde_json::from_str(&input)?;
    Ok(hook_input)
}

pub fn send_hook_output(output: &HookOutput) {
    println!("{}", serde_json::to_string(output).unwrap());
}
