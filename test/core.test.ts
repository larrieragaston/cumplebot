import { describe as suite, expect, it } from "vitest";
import { cleanName, daysBetween, extractEntry, nextOccurrence, nowIn, occursOn, parseDate } from "../src/dates";
import { describe, isSimilarName, matchByName, parseCommand, parseLine, reminderMessage } from "../src/bot";
import type { Event } from "../src/db";

suite("parseDate", () => {
  it("acepta formatos numéricos, con o sin año", () => {
    expect(parseDate("15/03", 2026)).toEqual({ day: 15, month: 3, year: null });
    expect(parseDate("5-3-1990", 2026)).toEqual({ day: 5, month: 3, year: 1990 });
    expect(parseDate("29.02", 2026)).toEqual({ day: 29, month: 2, year: null });
    expect(parseDate("15 / 3 / 90", 2026)).toEqual({ day: 15, month: 3, year: 1990 });
    expect(parseDate("1/1/05", 2026)).toEqual({ day: 1, month: 1, year: 2005 });
  });

  it("acepta meses en texto", () => {
    expect(parseDate("15 de marzo", 2026)).toEqual({ day: 15, month: 3, year: null });
    expect(parseDate("el 2 de Mayo de 1990", 2026)).toEqual({ day: 2, month: 5, year: 1990 });
    expect(parseDate("7 sept", 2026)).toEqual({ day: 7, month: 9, year: null });
    expect(parseDate("1ro de diciembre", 2026)).toEqual({ day: 1, month: 12, year: null });
  });

  it("rechaza fechas inválidas", () => {
    for (const bad of ["31/04", "hola", "15/13", "29/02/2023", "1/1/2999", "0/1", "30 de febrero"]) {
      expect(() => parseDate(bad, 2026), bad).toThrow();
    }
  });
});

suite("extractEntry", () => {
  const cases: [string, string, number, number, number | null][] = [
    ["Juan Pérez 15/03", "Juan Pérez", 15, 3, null],
    ["Juan Pérez 15/03/1990", "Juan Pérez", 15, 3, 1990],
    ["cumple de Caro el 7/11", "Caro", 7, 11, null],
    ["Ana: 2 de mayo de 1990", "Ana", 2, 5, 1990],
    ["15/03 - Tío Beto", "Tío Beto", 15, 3, null],
    ["agregá a Martín, 3 de junio", "Martín", 3, 6, null],
    ["El cumple de María de los Ángeles es el 8 de agosto", "María de los Ángeles", 8, 8, null],
    ["• Lucho 20/1", "Lucho", 20, 1, null],
  ];
  for (const [input, name, day, month, year] of cases) {
    it(input, () => {
      expect(extractEntry(input, 2026)).toEqual({ name, date: { day, month, year } });
    });
  }

  it("informa qué falta", () => {
    expect(extractEntry("Juan", 2026)).toEqual({ error: "no encontré una fecha" });
    expect(extractEntry("15/03", 2026)).toEqual({ error: "falta el nombre" });
  });

  it("cleanName", () => {
    expect(cleanName("  cumple de  Juan :")).toBe("Juan");
  });
});

suite("ocurrencias", () => {
  it("29/02 cae el 28/02 en años no bisiestos", () => {
    expect(occursOn(29, 2, { year: 2027, month: 2, day: 28 })).toBe(true);
    expect(occursOn(29, 2, { year: 2028, month: 2, day: 28 })).toBe(false);
    expect(occursOn(29, 2, { year: 2028, month: 2, day: 29 })).toBe(true);
  });

  it("próxima ocurrencia", () => {
    const today = { year: 2026, month: 10, day: 24 };
    expect(nextOccurrence(24, 10, today)).toEqual(today);
    expect(nextOccurrence(1, 1, today)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(daysBetween(today, nextOccurrence(25, 10, today))).toBe(1);
  });

  it("nowIn respeta la zona horaria", () => {
    // 02:00 UTC del 25/10 son las 23:00 del 24/10 en Buenos Aires
    const at = new Date(Date.UTC(2026, 9, 25, 2));
    expect(nowIn("America/Argentina/Buenos_Aires", at)).toEqual({ year: 2026, month: 10, day: 24, hour: 23 });
  });
});

suite("bot", () => {
  const juan: Event = { id: 3, chat_id: 1, kind: "birthday", name: "Juan", day: 25, month: 10, year: 1990, greeting: null, phone: null };
  const anon: Event = { ...juan, id: 4, name: "Ana", year: null };
  const today = { year: 2026, month: 10, day: 24 };

  it("parsea comandos con y sin barra", () => {
    expect(parseCommand("/cumple@MiBot Juan Pérez 15/03")).toEqual({ command: "add", rest: "Juan Pérez 15/03" });
    expect(parseCommand("Lista")).toEqual({ command: "list", rest: "" });
    expect(parseCommand("próximos")).toEqual({ command: "upcoming", rest: "" });
    expect(parseCommand("borrar Juan")).toEqual({ command: "delete", rest: "Juan" });
    expect(parseCommand("/xyz")).toEqual({ command: "unknown", rest: "" });
    // Texto libre (incluso empezando con "cumple") se trata como alta, no como comando
    expect(parseCommand("cumple de Juan 15/03")).toBeNull();
    expect(parseCommand("Juan 15/03")).toBeNull();
  });

  it("busca por nombre sin acentos y prefiere coincidencia exacta", () => {
    const events: Event[] = [
      { ...juan, id: 1, name: "Juan" },
      { ...juan, id: 2, name: "Juan Pérez" },
      { ...juan, id: 3, name: "Martín" },
    ];
    expect(matchByName(events, "juan").map((e) => e.id)).toEqual([1]);
    expect(matchByName(events, "perez").map((e) => e.id)).toEqual([2]);
    expect(matchByName(events, "MARTIN").map((e) => e.id)).toEqual([3]);
    expect(matchByName(events, "ju").map((e) => e.id)).toEqual([1, 2]);
  });

  it("formatea listados y avisos con y sin año", () => {
    expect(describe(juan, today)).toBe("🎂 #3 Juan — 25/10 (cumple 36) — mañana");
    expect(describe(anon, today)).toBe("🎂 #4 Ana — 25/10 — mañana");
    const bday = { year: 2026, month: 10, day: 25 };
    expect(reminderMessage(juan, bday).text).toContain("Cumple 36");
    expect(reminderMessage(anon, bday)).toEqual({
      text: "🎂 ¡Hoy es el cumpleaños de <b>Ana</b>!\nNo te olvides de saludar 😉",
      buttons: [],
    });
  });
});

suite("saludos", () => {
  const base: Event = { id: 1, chat_id: 1, kind: "birthday", name: "Juan <3", day: 25, month: 10, year: null, greeting: null, phone: null };
  const bday = { year: 2026, month: 10, day: 25 };

  it("parseLine lee teléfono y saludo opcionales", () => {
    expect(parseLine("Juan 15/03 | +54 9 11 2233-4455 | Feliz cumple crack!", 2026)).toEqual({
      name: "Juan", date: { day: 15, month: 3, year: null }, phone: "5491122334455", greeting: "Feliz cumple crack!",
    });
    expect(parseLine("Juan 15/03 | Feliz cumple 15 de marzo", 2026)).toMatchObject({ phone: null, greeting: "Feliz cumple 15 de marzo" });
    expect(parseLine("Juan 15/03", 2026)).toMatchObject({ phone: null, greeting: null });
  });

  it("el aviso muestra el saludo y arma los botones", () => {
    const msg = reminderMessage({ ...base, greeting: "Feliz cumple <amigo> & más", phone: "5491122334455" }, bday);
    expect(msg.text).toContain("<b>Juan &lt;3</b>");
    expect(msg.text).toContain("<blockquote>Feliz cumple &lt;amigo&gt; &amp; más</blockquote>");
    expect(msg.buttons).toEqual([
      [{ text: "💬 Saludar por WhatsApp", url: "https://wa.me/5491122334455?text=Feliz%20cumple%20%3Camigo%3E%20%26%20m%C3%A1s" }],
      [{ text: "📋 Copiar saludo", copy_text: { text: "Feliz cumple <amigo> & más" } }],
    ]);
  });

  it("con teléfono y sin saludo, abre WhatsApp con un saludo genérico", () => {
    const msg = reminderMessage({ ...base, phone: "5491122334455" }, bday);
    expect(msg.buttons).toHaveLength(1);
    expect(msg.text).toContain("No te olvides de saludar");
  });
});

suite("nombres parecidos", () => {
  it("detecta posibles repetidos", () => {
    expect(isSimilarName("Juan", "Juan Pérez")).toBe(true);
    expect(isSimilarName("juan perez", "Juan Pérez")).toBe(true);
    expect(isSimilarName("Sofi Gómez", "Sofi Ramírez")).toBe(true);
    expect(isSimilarName("Lucía", "Lucía Torres")).toBe(true);
    expect(isSimilarName("Pérez", "Juan Perez")).toBe(true);
  });

  it("no confunde nombres distintos", () => {
    expect(isSimilarName("Juan", "Juana")).toBe(false);
    expect(isSimilarName("Ana", "Mariana López")).toBe(false);
    expect(isSimilarName("Lu", "Lucas")).toBe(false);
    expect(isSimilarName("Martín Díaz", "Mati Ruiz")).toBe(false);
  });
});

