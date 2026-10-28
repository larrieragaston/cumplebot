// Parseo laxo de fechas y cálculo de ocurrencias anuales (sin depender de la zona horaria del runtime).

export interface YMD {
  year: number;
  month: number;
  day: number;
}

export interface ParsedDate {
  day: number;
  month: number;
  year: number | null;
}

export interface FoundDate {
  start: number;
  end: number;
  date?: ParsedDate;
  error?: string;
}

const MONTHS: Record<string, number> = {
  enero: 1, ene: 1,
  febrero: 2, feb: 2,
  marzo: 3, mar: 3,
  abril: 4, abr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6,
  julio: 7, jul: 7,
  agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sept: 9, sep: 9, set: 9,
  octubre: 10, oct: 10,
  noviembre: 11, nov: 11,
  diciembre: 12, dic: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

// 15/03, 15-3-1990, 15.03.90
const NUMERIC_RE = /(?<!\d)(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{4}|\d{2}))?(?!\d)/;
// 15 de marzo, 1ro de mayo de 1990, 15 mar 90
const TEXT_RE = new RegExp(
  `(?<!\\d)(\\d{1,2})\\s*(?:ro|º|°)?\\s*(?:de\\s+)?(${MONTH_ALT})\\b\\.?(?:\\s*(?:de|del)?\\s*(\\d{4}|\\d{2})(?!\\d))?`,
);

/** Minúsculas y sin acentos, preservando la longitud (para poder mapear posiciones al texto original). */
export function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const base = [...ch.normalize("NFD")][0].toLowerCase();
    // Si por algún motivo cambia la cantidad de unidades UTF-16, dejamos el original
    out += base.length === ch.length ? base : ch;
  }
  return out;
}

export function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function fullYear(text: string | undefined, currentYear: number): number | null {
  if (!text) return null;
  const n = Number(text);
  if (text.length === 4) return n;
  // 90 -> 1990, 05 -> 2005
  return n <= currentYear % 100 ? 2000 + n : 1900 + n;
}

function validate(day: number, month: number, year: number | null, currentYear: number): string | null {
  if (month < 1 || month > 12) return "el mes tiene que estar entre 1 y 12";
  // 2000 es bisiesto, así 29/02 sin año es válido
  if (day < 1 || day > daysInMonth(year ?? 2000, month)) return "ese día no existe";
  if (year !== null && year > currentYear) return "el año no puede ser futuro";
  return null;
}

/** Busca la primera fecha dentro de un texto libre. */
export function findDate(text: string, currentYear: number): FoundDate | null {
  const folded = fold(text);
  const candidates = [NUMERIC_RE.exec(folded), TEXT_RE.exec(folded)].filter((m): m is RegExpExecArray => m !== null);
  if (!candidates.length) return null;
  const m = candidates.sort((a, b) => a.index - b.index)[0];
  const day = Number(m[1]);
  const month = /^\d+$/.test(m[2]) ? Number(m[2]) : MONTHS[m[2]];
  const year = fullYear(m[3], currentYear);
  const span = { start: m.index, end: m.index + m[0].length };
  const error = validate(day, month, year, currentYear);
  return error ? { ...span, error } : { ...span, date: { day, month, year } };
}

/** Como findDate pero lanza Error si no hay una fecha válida. */
export function parseDate(text: string, currentYear: number): ParsedDate {
  const found = findDate(text, currentYear);
  if (!found) throw new Error("no encontré una fecha (ej: 15/03, 15/03/1990 o 15 de marzo)");
  if (found.error) throw new Error(found.error);
  return found.date!;
}

const LEADING_FILLER = /^(?:(?:agrega(?:r|me)?|anota(?:r|me)?|carga(?:r|me)?|nuevo|cumple(?:anos)?|a|al|el|la|los|de|del)\s+)+/;
const TRAILING_FILLER = /(?:\s+(?:cumple(?:anos)?|es|el|la|nacio|naci|fecha))+$/;
const EDGE_PUNCT = /^[\s:,;\-–—•*>]+|[\s:,;\-–—.]+$/g;

/** Limpia el nombre que queda alrededor de la fecha: "Cumple de Juan:" -> "Juan". */
export function cleanName(text: string): string {
  let s = text.replace(/\s+/g, " ").replace(EDGE_PUNCT, "");
  for (let prev = ""; prev !== s; ) {
    prev = s;
    const lead = LEADING_FILLER.exec(fold(s));
    if (lead) s = s.slice(lead[0].length);
    const trail = TRAILING_FILLER.exec(fold(s));
    if (trail) s = s.slice(0, trail.index);
    s = s.replace(EDGE_PUNCT, "");
  }
  return s;
}

/** Extrae nombre y fecha de una línea libre: "Juan Pérez 15/03", "cumple de Ana el 2 de mayo"... */
export function extractEntry(text: string, currentYear: number): { name: string; date: ParsedDate } | { error: string } {
  const found = findDate(text, currentYear);
  if (!found) return { error: "no encontré una fecha" };
  if (found.error) return { error: found.error };
  const name = cleanName(`${text.slice(0, found.start)} ${text.slice(found.end)}`);
  if (!name) return { error: "falta el nombre" };
  return { name, date: found.date! };
}

/** Fecha en que cae day/month en un año dado (29/02 cae el 28/02 en años no bisiestos). */
function actualDay(day: number, month: number, year: number): YMD {
  if (month === 2 && day === 29 && !isLeap(year)) return { year, month: 2, day: 28 };
  return { year, month, day };
}

function toUtc(d: YMD): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

export function daysBetween(from: YMD, to: YMD): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

export function occursOn(day: number, month: number, d: YMD): boolean {
  return daysBetween(actualDay(day, month, d.year), d) === 0;
}

export function nextOccurrence(day: number, month: number, today: YMD): YMD {
  const candidate = actualDay(day, month, today.year);
  return daysBetween(today, candidate) >= 0 ? candidate : actualDay(day, month, today.year + 1);
}

export function formatDate(day: number, month: number, year?: number | null): string {
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return year ? `${dd}/${mm}/${year}` : `${dd}/${mm}`;
}

/** Fecha y hora actuales en una zona horaria IANA. */
export function nowIn(timeZone: string, at: Date = new Date()): YMD & { hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}
