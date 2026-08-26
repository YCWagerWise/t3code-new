use std::path::{Path, PathBuf};

const DEFAULT_AGENT_DATA_DIR: &str = ".t3code-agent";

fn absolute_from(base: &Path, path: PathBuf) -> PathBuf {
    let candidate = if path.is_absolute() {
        path
    } else {
        base.join(path)
    };
    std::fs::canonicalize(&candidate).unwrap_or(candidate)
}

pub fn resolve_workspace_root() -> PathBuf {
    match std::env::var("T3CODE_WORKSPACE") {
        Ok(root) => absolute_from(
            &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            PathBuf::from(root),
        ),
        Err(_) => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

pub fn resolve_agent_data_root(workspace_root: &Path) -> PathBuf {
    match std::env::var("T3CODE_AGENT_DATA") {
        Ok(data) => absolute_from(
            &std::env::current_dir().unwrap_or_else(|_| workspace_root.to_path_buf()),
            PathBuf::from(data),
        ),
        Err(_) => workspace_root.join(DEFAULT_AGENT_DATA_DIR),
    }
}

pub fn workspace_paths() -> (PathBuf, PathBuf) {
    let workspace_root = resolve_workspace_root();
    let agent_data = resolve_agent_data_root(&workspace_root);
    (workspace_root, agent_data)
}

pub fn agent_data_for_workspace(workspace_root: &Path) -> PathBuf {
    resolve_agent_data_root(workspace_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn default_agent_data_is_anchored_to_workspace_not_process_cwd() {
        let _guard = env_lock().lock().unwrap();
        std::env::remove_var("T3CODE_AGENT_DATA");
        let workspace = std::env::temp_dir().join(format!("t3-paths-{}", uuid::Uuid::new_v4()));
        let cwd_a = workspace.join("backend");
        let cwd_b = workspace.join("nested").join("runner");
        std::fs::create_dir_all(&cwd_a).unwrap();
        std::fs::create_dir_all(&cwd_b).unwrap();

        let before = std::env::current_dir().unwrap();
        std::env::set_current_dir(&cwd_a).unwrap();
        let from_backend = resolve_agent_data_root(&workspace);
        std::env::set_current_dir(&cwd_b).unwrap();
        let from_nested = resolve_agent_data_root(&workspace);
        std::env::set_current_dir(before).unwrap();

        assert_eq!(from_backend, workspace.join(DEFAULT_AGENT_DATA_DIR));
        assert_eq!(from_nested, from_backend);
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn explicit_agent_data_is_canonicalized_when_it_exists() {
        let _guard = env_lock().lock().unwrap();
        let workspace = std::env::temp_dir().join(format!("t3-paths-{}", uuid::Uuid::new_v4()));
        let data = workspace.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::env::set_var("T3CODE_AGENT_DATA", data.join("..").join("data"));

        let resolved = resolve_agent_data_root(&workspace);

        std::env::remove_var("T3CODE_AGENT_DATA");
        assert_eq!(resolved, std::fs::canonicalize(&data).unwrap());
        let _ = std::fs::remove_dir_all(&workspace);
    }
}
