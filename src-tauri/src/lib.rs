use serde::Deserialize;
use std::{env, fs, path::PathBuf};
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[derive(Deserialize)]
struct Runtime {
    port: u16,
    token: String,
}

fn data_root() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("CO_AGENT_HOME") {
        return Ok(PathBuf::from(configured));
    }
    let home = env::var_os("HOME").ok_or("HOME is unavailable")?;
    Ok(PathBuf::from(home).join(".co-agent"))
}

fn runtime_url() -> Result<tauri::Url, String> {
    let runtime_path = data_root()?.join("runtime.json");
    let runtime: Runtime = serde_json::from_str(
        &fs::read_to_string(&runtime_path)
            .map_err(|error| format!("Could not read {}: {error}", runtime_path.display()))?,
    )
    .map_err(|error| format!("Invalid Co-Agent runtime file: {error}"))?;
    let mut url = tauri::Url::parse(&format!("http://127.0.0.1:{}/", runtime.port))
        .map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("token", &runtime.token);
        if let Some(index) = env::args().position(|arg| arg == "--session") {
            if let Some(session_id) = env::args().nth(index + 1) {
                query.append_pair("session", &session_id);
            }
        }
        if let Some(index) = env::args().position(|arg| arg == "--launch-id") {
            if let Some(launch_id) = env::args().nth(index + 1) {
                query.append_pair("launch", &launch_id);
            }
        }
    }
    Ok(url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let url = runtime_url().unwrap_or_else(|error| {
        eprintln!("[co-agent] {error}");
        std::process::exit(1);
    });
    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
                .title("Co-Agent")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1080.0, 680.0)
                .resizable(true)
                .decorations(true)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Co-Agent");
}
