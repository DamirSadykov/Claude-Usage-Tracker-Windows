//! Диагностика и отчёты о сбоях.
//!
//! Две задачи:
//!  1. Зафиксировать структурированный отчёт, когда приложение не смогло
//!     сделать то, что должно, — прежде всего когда не удалось получить данные
//!     об использовании. Отчёт собирает короткое резюме, сведения об окружении
//!     и хвост лог-файла.
//!  2. Превратить отчёт в заранее заполненный GitHub issue, который пользователь
//!     открывает одним кликом, — чтобы к нам возвращалась диагностика, а не
//!     пустой баг-репорт.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// Репозиторий, на который нацелена кнопка «Сообщить о проблеме».
pub const ISSUE_NEW_URL: &str =
    "https://github.com/DamirSadykov/Claude-Usage-Tracker-Windows/issues/new";

/// Имя файла, в который пишет плагин логирования (внутри app log dir).
pub const LOG_FILE_NAME: &str = "claude-usage-tracker.log";

/// Файл-маркер последней паники; читается и удаляется на следующем запуске.
pub const PANIC_FILE_NAME: &str = "last-panic.txt";

/// Сколько байт хвоста лога встраивать в отчёт.
const LOG_TAIL_BYTES: u64 = 16 * 1024;

/// GitHub ограничивает длину URL issue — держим тело с запасом ниже предела.
const ISSUE_BODY_MAX: usize = 6000;

/// Один диагностический отчёт, готовый к показу в UI и к отправке как issue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagReport {
    /// Устойчивая категория: `usage-fetch`, `panic`, `frontend`, …
    pub kind: String,
    /// Однострочное человекочитаемое резюме для UI.
    pub summary: String,
    /// Полные детали ошибки (могут быть многострочными).
    pub detail: String,
    /// Версия приложения.
    pub version: String,
    /// Строка ОС / архитектуры.
    pub os: String,
    /// Время фиксации в RFC3339.
    pub at: String,
    /// Хвост лог-файла на момент фиксации.
    pub log_tail: String,
}

/// Последний зафиксированный отчёт. Живёт в Tauri-state; фронтенд забирает его
/// через команду `get_last_diag` и предлагает создать issue.
#[derive(Default)]
pub struct DiagStore {
    last: Mutex<Option<DiagReport>>,
}

impl DiagStore {
    pub fn set(&self, report: DiagReport) {
        *self.last.lock().unwrap() = Some(report);
    }

    pub fn get(&self) -> Option<DiagReport> {
        self.last.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        *self.last.lock().unwrap() = None;
    }
}

// --- Захват паник в файл (для показа отчёта на следующем запуске) ---

static PANIC_FILE: OnceLock<PathBuf> = OnceLock::new();

/// Ставит глобальный хук паники: пишет панику в лог и в файл-маркер, затем
/// вызывает прежний хук. Вызывать как можно раньше в `run()`.
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info.to_string();
        log::error!(target: "panic", "{}", msg);
        if let Some(path) = PANIC_FILE.get() {
            let _ = std::fs::write(path, &msg);
        }
        prev(info);
    }));
}

/// Сообщает хуку, куда писать файл-маркер паники (внутри app log dir).
pub fn set_panic_file(log_dir: &Path) {
    let _ = PANIC_FILE.set(log_dir.join(PANIC_FILE_NAME));
}

/// Если на прошлом запуске была паника — собирает из неё отчёт и удаляет маркер.
pub fn take_panic_report(log_dir: &Path, version: &str) -> Option<DiagReport> {
    let path = log_dir.join(PANIC_FILE_NAME);
    let detail = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let summary = detail
        .lines()
        .next()
        .unwrap_or("Аварийное завершение приложения")
        .to_string();
    Some(DiagReport {
        kind: "panic".into(),
        summary,
        detail,
        version: version.to_string(),
        os: os_string(),
        at: chrono::Utc::now().to_rfc3339(),
        log_tail: read_log_tail(&log_dir.join(LOG_FILE_NAME)).unwrap_or_default(),
    })
}

// --- Сборка отчёта ---

/// Собирает отчёт по факту ошибки. `log_file` — путь к лог-файлу, чтобы
/// подмешать его хвост (самое полезное для диагностики).
pub fn capture(
    kind: &str,
    summary: impl Into<String>,
    detail: impl Into<String>,
    version: &str,
    log_file: Option<&Path>,
) -> DiagReport {
    DiagReport {
        kind: kind.to_string(),
        summary: summary.into(),
        detail: detail.into(),
        version: version.to_string(),
        os: os_string(),
        at: chrono::Utc::now().to_rfc3339(),
        log_tail: log_file.and_then(read_log_tail).unwrap_or_default(),
    }
}

fn os_string() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Читает последние `LOG_TAIL_BYTES` лог-файла. Срез по произвольному смещению
/// может разрезать UTF-8, поэтому читаем байты и декодируем lossy, отбрасывая
/// первую неполную строку.
fn read_log_tail(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        if let Some(nl) = text.find('\n') {
            text = text[nl + 1..].to_string();
        }
    }
    Some(text)
}

// --- GitHub issue ---

/// Строит URL заранее заполненного GitHub issue. Резюме и детали короткие и идут
/// первыми; остаток бюджета отдаётся хвосту лога — обрезаем его с начала, чтобы
/// сохранить самые свежие строки.
pub fn build_issue_url(r: &DiagReport) -> String {
    let title = format!("[{}] {}", r.kind, truncate_tail_keep_head(&r.summary, 80));

    let header = format!(
        "<!-- Отчёт сформирован автоматически. Удалите всё, что не хотите публиковать. -->\n\n\
         **Что произошло:**\n\n{}\n\n\
         **Детали:**\n\n```\n{}\n```\n\n\
         **Версия:** {}\n**ОС:** {}\n**Время:** {}\n\n",
        r.summary, r.detail, r.version, r.os, r.at,
    );

    let budget = ISSUE_BODY_MAX.saturating_sub(header.len() + 64);
    let log = truncate_keep_tail(&r.log_tail, budget);
    let body = format!("{}**Лог (хвост):**\n\n```\n{}\n```\n", header, log);

    format!(
        "{}?labels=bug&title={}&body={}",
        ISSUE_NEW_URL,
        urlencode(&title),
        urlencode(&body),
    )
}

/// Оставляет начало строки до `max` байт (по границе символов).
fn truncate_tail_keep_head(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Оставляет конец строки в пределах `max` байт (по границе символов).
fn truncate_keep_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…(обрезано)\n{}", &s[start..])
}

/// Процентное кодирование по RFC 3986 (без внешних зависимостей).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(detail: &str, log_tail: &str) -> DiagReport {
        DiagReport {
            kind: "usage-fetch".into(),
            summary: "summary".into(),
            detail: detail.into(),
            version: "0.2.0".into(),
            os: "windows x86_64".into(),
            at: "2026-05-29T00:00:00Z".into(),
            log_tail: log_tail.into(),
        }
    }

    #[test]
    fn urlencode_escapes_reserved_and_keeps_unreserved() {
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencode("A-z_0.9~"), "A-z_0.9~");
        // Кириллица кодируется как UTF-8 байты.
        assert_eq!(urlencode("я"), "%D1%8F");
    }

    #[test]
    fn truncate_keep_tail_preserves_recent_lines_on_char_boundary() {
        let s = "стертое начало\nсвежий хвост";
        let out = truncate_keep_tail(s, 20);
        assert!(out.starts_with("…(обрезано)\n"));
        assert!(out.ends_with("хвост"));
        // Никаких разрезанных UTF-8 символов.
        assert!(out.is_char_boundary(out.len()));
    }

    #[test]
    fn issue_url_stays_within_budget_and_includes_fields() {
        let big_log = "log line\n".repeat(5000);
        let url = build_issue_url(&report("boom", &big_log));
        assert!(url.starts_with(ISSUE_NEW_URL));
        assert!(url.contains("labels=bug"));
        // Тело обрезано до бюджета: сырой URL не должен раздуваться без предела.
        assert!(url.len() < ISSUE_BODY_MAX * 4, "url len = {}", url.len());
    }
}
