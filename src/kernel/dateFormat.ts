// Locale-aware date formatting shared across the analytics views. Russian gets
// dotted numeric dates (31.12.2026); everything else falls back to en-US
// (12/31/2026). Centralised so the charts, the standalone window and any future
// surface render dates the same way.

function bcp47(locale: string): string {
  return locale === "ru" ? "ru-RU" : "en-US";
}

// Full timestamp (ISO string with time) → numeric date + time, e.g. ru
// "31.12.2026, 13:57" / en "12/31/2026, 01:57 PM". Returns the raw input
// unchanged if it can't be parsed.
export function fmtDateTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(bcp47(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// A calendar day ("YYYY-MM-DD", no time) → numeric date, e.g. ru "31.12.2026".
// Parsed at local midnight so the label doesn't slip to the previous day in
// negative-offset timezones — a bare "YYYY-MM-DD" parses as UTC midnight.
export function fmtDay(day: string, locale: string): string {
  const d = new Date(day + "T00:00:00");
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString(bcp47(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
