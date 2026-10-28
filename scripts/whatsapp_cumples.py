#!/usr/bin/env python3
"""
Busca cumpleaños en el historial de WhatsApp de un backup local de iPhone (encriptado o no).

Toma los mensajes que mandaste vos con "feliz cumple", "hbd", "que los cumplas", etc.
La fecha del mensaje es el candidato a cumpleaños. En chats individuales la persona es el contacto;
en grupos se deduce por la mención (@), el nombre o apodo usado en el saludo, o quién dijo "gracias".
Después une duplicados (misma persona en varios chats/grupos o con varios números) y separa
lo que conviene revisar. También guarda tu último saludo a cada persona y su número.

Si el backup está encriptado, pide la contraseña y desencripta SOLO la base de WhatsApp
en una carpeta temporal que se borra al terminar. Todo corre local.

Uso (desde la raíz del proyecto, en una terminal normal):
    npm run whatsapp -- --backup ~/Desktop/<carpeta-del-backup>

El resultado es un .txt con una línea por persona, listo para revisar y mandarle al bot:
    Nombre DD/MM | +teléfono | saludo   # contexto (el bot ignora lo que va después de "#")
"""
from __future__ import annotations

import argparse
import re
from collections import deque
import sqlite3
import tempfile
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from backup import Backup, die, find_backup

WA_DOMAIN = "AppDomainGroup-group.net.whatsapp.WhatsApp.shared"
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
TZ = ZoneInfo("America/Argentina/Buenos_Aires")

# Mensajes tuyos que siguen al saludo (ej. "Feliz cumple!!" + "Que la pases genial") se suman si llegan dentro de este lapso
FOLLOW_UP_SECONDS = 180
MAX_FOLLOW_UPS = 3
MAX_GREETING_CHARS = 300
# Dos candidatos con fechas a esta distancia o menos pueden ser la misma persona (saludos atrasados)
SAME_DAY_TOLERANCE = 1
# Ejemplos de tu forma de escribir, para que después se puedan generar saludos con tu estilo
STYLE_SAMPLES_PER_CHAT = 12
STYLE_GENERAL_SAMPLES = 60
URL_RE = re.compile(r"https?://|www\.")

# Se aplica sobre texto en minúscula y sin acentos
BIRTHDAY_RE = re.compile(
    r"feliz\s+cumple|feliz\s+vuelta\s+al\s+sol|\bhbd\b|happy\s+b(irth)?-?day|que\s+los?\s+cumplas|felices\s+\d{1,3}\b"
)
THANKS_RE = re.compile(r"\bgracias\b")
MENTION_RE = re.compile(r"@(\d{6,})")
# Nombre después del saludo: "feliz cumple Martin!!", "feliz cumpleaños a Caro", "cumpleaños para Camila"
NAME_AFTER_RE = re.compile(
    r"(?:cumple\w*|hbd|birthday|bday|b-day|cumplas|sol)(?:[\s,!.]+(?:a|al|para))?[\s,!.]+(?:la\s+|el\s+|mi\s+)?([A-Za-zÀ-ÿ]{2,})"
)
# Nombre al principio: "Lucho! Feliz cumple", "Ofe, feliz cumple"
NAME_BEFORE_RE = re.compile(r"^\W*([A-Za-zÀ-ÿ]{2,})\s*[!,.]+\s*(?:muy\s+)*feliz", re.IGNORECASE)
# En un chat individual, "feliz cumple a Vale" / "al abuelo": el saludo es para otra persona
OTHER_PERSON_RE = re.compile(r"cumple\w*\s+(?:a|al|para)\s+(?:la\s+|el\s+|mi\s+|tu\s+)?([a-z]{2,})")

# Palabras que pueden aparecer donde iría el nombre pero no lo son (sin acentos, sin letras repetidas)
STOPWORDS = {
    "feliz", "que", "te", "muy", "para", "de", "del", "el", "la", "las", "y", "todo", "todos", "todas", "lo", "los",
    "hoy", "ayer", "mi", "tu", "su", "mas", "muchas", "mucho", "dia", "anio", "ano", "bien", "pasala", "pasalo",
    "disfruta", "abrazo", "besos", "beso", "cumple", "cumpleanos", "felicidades", "jaja", "jajaja", "ahi", "vos", "ti",
    "como", "con", "sin", "por", "en", "un", "una", "uno", "nos", "les", "le", "se", "ya", "no", "si", "va", "es",
    "fue", "atrasado", "atrasada", "atrasadisimo", "tambien", "todavia", "otra", "otro", "mandale", "mandenle",
    "manda", "mandamos", "mandale", "che", "amigo", "amiga", "amigos", "genio", "genia", "crack", "capo", "bro",
    "querido", "querida", "queridos", "lindo", "linda", "hermoso", "hermosa", "a", "al", "ese", "esa", "este", "esta",
    "uds", "ustedes", "usted", "ella", "ellos", "ellas", "gente", "chicos", "chicas", "muchachos", "familia",
    "hola", "buen", "buenas", "eh", "ah", "pero", "bueno", "dale", "obvio", "perdon", "sorry",
}
# Apodos/relaciones: no son nombres, pero sirven para cruzar con otros chats ("feliz cumple primo")
RELATIONAL = {
    "papa", "pa", "papi", "mama", "ma", "mami", "primo", "prima", "tio", "tia", "abuelo", "abuela", "hermano",
    "hermana", "hermanito", "hermanita", "negro", "negra", "negrito", "negrita", "gordo", "gorda", "nena", "nene",
    "viejo", "vieja", "suegro", "suegra", "cunado", "cunada", "padrino", "madrina", "sobrino", "sobrina", "hijo",
    "hija", "vago", "loco", "loca",
}


def fold(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn").lower()


def collapse(text: str) -> str:
    """'Caroooooo' -> 'Caro', 'cumpleeee' -> 'cumple'."""
    return re.sub(r"(\w)\1{2,}", r"\1", text)


def norm(text: str) -> str:
    return collapse(fold(text))


def undiminish(word: str) -> str:
    """'negrito' -> 'negro', 'marianito' -> 'mariano', 'juancito' -> 'juan'."""
    word = re.sub(r"(?<=\w{3})cit([oa])$", "", word)
    return re.sub(r"(?<=\w{3})it([oa])$", r"\1", word)


def words(text: str) -> set[str]:
    """Palabras normalizadas, en su forma original y sin diminutivo ('pablito' y 'pablo')."""
    found = re.findall(r"[a-z]{2,}", norm(text))
    return set(found) | {undiminish(w) for w in found}


def is_phone_like(name: str | None) -> bool:
    return not name or bool(re.fullmatch(r"[\s+\d\-‐-―‎‏‪-‮()]+", name))


def is_id_like(name: str | None) -> bool:
    return is_phone_like(name) or "=" in name or name.lstrip("+").isdigit()


def phone_from_jid(jid: str | None) -> str | None:
    # Los JID "@lid" son identificadores anónimos, no números
    m = re.fullmatch(r"(\d{8,15})@s\.whatsapp\.net", jid or "")
    return f"+{m.group(1)}" if m else None


def one_line(text: str) -> str:
    """Saludo en una línea, sin los separadores que usa el formato del archivo."""
    s = " ".join(text.split()).replace("|", "/").replace("#", "")
    return s if len(s) <= MAX_GREETING_CHARS else s[: MAX_GREETING_CHARS - 3] + "..."


def pretty_name(word: str) -> str:
    w = collapse(word)
    return w[0].upper() + w[1:] if w.islower() else w


def name_in_text(text: str) -> tuple[str, bool] | None:
    """(nombre, es_apodo) que aparece en un saludo, prefiriendo un nombre real a un apodo/relación."""
    relational = None
    for m in [*NAME_BEFORE_RE.finditer(text), *NAME_AFTER_RE.finditer(text)]:
        word = m.group(1)
        key = norm(word)
        if key in STOPWORDS or len(key) < 2:
            continue
        if key in RELATIONAL:
            relational = relational or key
            continue
        return pretty_name(word), False
    return (relational, True) if relational else None


def columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


@dataclass
class Greeting:
    ts: float
    day: date
    parts: list[str]
    phone: str | None = None
    own: bool = True  # False si vino de otro candidato que se unió a este (solo suma para la fecha)


@dataclass
class Candidate:
    kind: str  # "chat" o "grupo"
    chats: list[str]
    chat_pks: list[int] = field(default_factory=list)
    name: str | None = None
    phone: str | None = None
    agendado: bool = False
    name_source: str | None = None  # "perfil" o "saludo" cuando no está agendado
    nick: str | None = None  # en grupos: palabra usada en el saludo
    relational: bool = False
    other_person: str | None = None
    greetings: list[Greeting] = field(default_factory=list)
    thanks: Counter = field(default_factory=Counter)
    also_in: list[str] = field(default_factory=list)
    hints: list[str] = field(default_factory=list)
    merged: bool = False

    @property
    def dates(self) -> list[date]:
        return [g.day for g in self.greetings]

    @property
    def month_day(self) -> tuple[int, int]:
        """Día/mes más repetido; ante empate, el más temprano (los saludos atrasados corren la fecha)."""
        counts = Counter((d.month, d.day) for d in self.dates)
        top = max(counts.values())
        return min(k for k, v in counts.items() if v == top)

    @property
    def fecha(self) -> str:
        month, day = self.month_day
        return f"{day:02d}/{month:02d}"

    @property
    def years(self) -> list[int]:
        return sorted({d.year for d in self.dates})

    @property
    def latest(self) -> Greeting:
        own = [g for g in self.greetings if g.own] or self.greetings
        return max(own, key=lambda g: g.ts)

    @property
    def greeting(self) -> str:
        return one_line(" ".join(self.latest.parts))

    def tokens(self) -> set[str]:
        return words(self.name or "") | ({self.nick} if self.nick else set())

    def greeting_words(self) -> set[str]:
        return set().union(*(words(" ".join(g.parts)) for g in self.greetings if g.own))

    def absorb(self, other: "Candidate", own: bool) -> None:
        for g in other.greetings:
            self.greetings.append(Greeting(g.ts, g.day, g.parts, g.phone, own and g.own))
        for chat in other.chats:
            if chat not in self.chats and chat not in self.also_in:
                self.also_in.append(chat)
        self.thanks.update(other.thanks)
        self.chat_pks.extend(pk for pk in other.chat_pks if pk not in self.chat_pks)
        other.merged = True


def day_distance(a: Candidate, b: Candidate) -> int:
    da = date(2000, *a.month_day).timetuple().tm_yday
    db = date(2000, *b.month_day).timetuple().tm_yday
    diff = abs(da - db)
    return min(diff, 366 - diff)


def nick_matches(nick: str, c: Candidate) -> bool:
    """¿La palabra usada en un saludo coincide con el nombre de c o con cómo lo saludás vos?"""
    nick = undiminish(norm(nick))
    for t in words(c.name or ""):
        if t.startswith(nick) or (len(t) >= 3 and nick.startswith(t)):
            return True
    return nick in c.greeting_words()


def load_people(conn: sqlite3.Connection) -> tuple[dict[str, str], set[str]]:
    """(JID -> mejor nombre conocido, todos los JID vistos). Prioridad: agendado > nombre en grupo > perfil."""
    names: dict[str, str] = {}
    seen: set[str] = set()
    if columns(conn, "ZWAPROFILEPUSHNAME") >= {"ZJID", "ZPUSHNAME"}:
        for jid, push in conn.execute("SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME"):
            seen.add(jid)
            if jid and push and not is_id_like(push):
                names[jid] = push
    gm_cols = columns(conn, "ZWAGROUPMEMBER")
    wanted = [c for c in ("ZCONTACTNAME", "ZFIRSTNAME") if c in gm_cols]
    for jid, *candidates in conn.execute(f"SELECT ZMEMBERJID, {', '.join(wanted or ['NULL'])} FROM ZWAGROUPMEMBER"):
        seen.add(jid)
        name = next((c for c in candidates if c and not is_id_like(c)), None)
        if jid and name:
            names[jid] = name
    for jid, partner in conn.execute("SELECT ZCONTACTJID, ZPARTNERNAME FROM ZWACHATSESSION"):
        seen.add(jid)
        if jid and not jid.endswith("@g.us") and not is_phone_like(partner):
            names[jid] = partner
    return names, seen


def member_names(conn: sqlite3.Connection, people: dict[str, str]) -> dict[int, str]:
    """Z_PK de miembro de grupo -> nombre visible (para las sugerencias de "gracias")."""
    out = {}
    for pk, jid in conn.execute("SELECT Z_PK, ZMEMBERJID FROM ZWAGROUPMEMBER"):
        if jid in people:
            out[pk] = people[jid]
    return out


def collect(conn: sqlite3.Connection) -> tuple[list[Candidate], int, dict[int, deque]]:
    people, seen_jids = load_people(conn)
    members = member_names(conn, people)
    found: dict[tuple, Candidate] = {}
    thanks: dict[tuple[int, date], Counter] = defaultdict(Counter)
    open_greeting: Greeting | None = None
    current_chat = None
    total = 0
    # Tus últimos mensajes (no de cumple) en cada chat individual: (ts, texto)
    samples: dict[int, deque] = defaultdict(lambda: deque(maxlen=STYLE_SAMPLES_PER_CHAT))

    rows = conn.execute(
        """SELECT m.ZTEXT, m.ZMESSAGEDATE, m.ZISFROMME, m.ZGROUPMEMBER, s.Z_PK, s.ZPARTNERNAME, s.ZCONTACTJID
           FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
           WHERE m.ZTEXT IS NOT NULL AND m.ZMESSAGEDATE IS NOT NULL
           ORDER BY s.Z_PK, m.ZMESSAGEDATE"""
    )
    group_greetings: list[tuple[int, str, Greeting, str]] = []
    for text, ts, from_me, member, chat_pk, chat_name, jid in rows:
        total += 1
        if chat_pk != current_chat:
            current_chat, open_greeting = chat_pk, None
        is_group = (jid or "").endswith("@g.us")
        chat_name = re.sub(r"[\u200e\u200f\u202a-\u202e]", "", chat_name or "") or None
        day = (APPLE_EPOCH + timedelta(seconds=ts)).astimezone(TZ).date()
        folded = fold(text)
        is_birthday = bool(from_me and BIRTHDAY_RE.search(folded))

        if is_group and not from_me and THANKS_RE.search(folded) and member in members:
            thanks[(chat_pk, day)][members[member]] += 1

        if open_greeting and not is_birthday:
            in_time = ts - open_greeting.ts <= FOLLOW_UP_SECONDS
            if from_me and in_time and len(open_greeting.parts) <= MAX_FOLLOW_UPS:
                open_greeting.parts.append(text)
                open_greeting.ts = ts
            # En grupos otros saludan al mismo tiempo; solo cortamos por tiempo
            elif not in_time or not is_group:
                open_greeting = None

        if not is_birthday:
            if from_me and not is_group and 2 <= len(text) <= 250 and not URL_RE.search(text):
                samples[chat_pk].append((ts, " ".join(text.split())))
            continue

        greeting = Greeting(ts=ts, day=day, parts=[text])
        open_greeting = greeting
        if is_group:
            group_greetings.append((chat_pk, chat_name or "?", greeting, text))
            continue

        c = found.get(("chat", chat_pk))
        if c is None:
            agendado = not is_phone_like(chat_name)
            c = found[("chat", chat_pk)] = Candidate(
                kind="chat",
                chats=[chat_name or "?"],
                name=chat_name if agendado else people.get(jid),
                phone=phone_from_jid(jid),
                agendado=agendado,
                name_source=None if agendado or not people.get(jid) else "perfil",
                chat_pks=[chat_pk],
            )
        greeting.phone = c.phone
        c.greetings.append(greeting)

    # Grupos: el saludado sale de la mención, del nombre/apodo en el texto o queda sin nombre
    for chat_pk, chat_name, greeting, text in group_greetings:
        name, phone, nick, relational = None, None, None, False
        for num in MENTION_RE.findall(text):
            for mjid in (f"{num}@s.whatsapp.net", f"{num}@lid"):
                if mjid in people:
                    name, phone = people[mjid], phone_from_jid(mjid)
                    break
            # Sin nombre conocido, solo lo tomamos como teléfono si WhatsApp lo conoce como número (no como ID anónimo @lid)
            if not name and f"{num}@s.whatsapp.net" in seen_jids:
                phone = f"+{num}"
            if name or phone:
                break
        if not name:
            found_name = name_in_text(MENTION_RE.sub(" ", text))
            if found_name:
                nick, relational = found_name
                name = None if relational else nick
        key_part = f"@{phone}" if phone and not name else norm(name or nick or "") or f"?{greeting.day.month}-{greeting.day.day}"
        key = ("grupo", chat_pk, key_part)
        c = found.get(key)
        if c is None:
            c = found[key] = Candidate(
                kind="grupo", chats=[chat_name], chat_pks=[chat_pk], name=name, phone=phone, nick=nick, relational=relational
            )
        greeting.phone = phone
        c.greetings.append(greeting)
        for d in (greeting.day, greeting.day + timedelta(days=1)):
            c.thanks.update(thanks.get((chat_pk, d), {}))

    return list(found.values()), total, samples


def dedupe(cands: list[Candidate]) -> list[Candidate]:
    chats = [c for c in cands if c.kind == "chat"]
    groups = [c for c in cands if c.kind == "grupo"]
    near = lambda a, b: day_distance(a, b) <= SAME_DAY_TOLERANCE  # noqa: E731

    # 1. Mismo contacto con varios números (cambió de teléfono, número del exterior)
    for i, a in enumerate(chats):
        for b in chats[i + 1 :]:
            if not a.merged and not b.merged and a.name and b.name and norm(a.name) == norm(b.name) and near(a, b):
                a.absorb(b, own=True)
    for c in chats:
        if not c.merged:
            c.phone = c.latest.phone or c.phone
    chats = [c for c in chats if not c.merged]

    # 2. Saludos en un chat individual que nombran a otra persona: "feliz cumple a Vale" (se marca para revisar)
    #    o un nombre suelto que coincide con otro contacto del mismo día (un saludo reenviado: se une a ese)
    for c in chats:
        latest_text = " ".join(c.latest.parts)
        m = OTHER_PERSON_RE.search(norm(latest_text))
        strict = m.group(1) if m and m.group(1) not in STOPWORDS else None
        found_name = name_in_text(latest_text)
        loose = norm(found_name[0]) if found_name and not found_name[1] else None
        for other, can_flag in ((strict, True), (loose, False)):
            if not other or (c.name and nick_matches(other, Candidate("chat", [], name=c.name))):
                continue
            twin = next((o for o in chats if o is not c and not o.merged and near(o, c) and nick_matches(other, o)), None)
            if twin:
                twin.absorb(c, own=False)
                break
            if can_flag:
                c.other_person = pretty_name(other)
                break
        # Sin agendar ni nombre de perfil: el nombre del saludo ("Caro. Feliz cumple") es casi seguro el del chat
        if not c.merged and not c.other_person and not c.name and loose:
            c.name, c.name_source = pretty_name(loose), "saludo"
    chats = [c for c in chats if not c.merged]

    # 3. Grupos que corresponden a alguien de los chats individuales
    for g in groups:
        twin = None
        if g.phone:
            twin = next((c for c in chats if c.phone == g.phone or any(x.phone == g.phone for x in c.greetings)), None)
        if not twin and g.name and not is_id_like(g.name):
            twin = next((c for c in chats if c.name and norm(c.name) == norm(g.name) and near(c, g)), None)
        if not twin and (g.nick or g.name):
            twin = next((c for c in chats if near(c, g) and nick_matches(g.nick or g.name, c)), None)
        if not twin:
            for person, _ in g.thanks.most_common(3):
                twin = next((c for c in chats if c.name and norm(c.name) == norm(person) and near(c, g)), None)
                if twin:
                    break
        if twin:
            twin.absorb(g, own=False)
    groups = [g for g in groups if not g.merged]

    # 4. La misma persona saludada en varios grupos (o con apodos parecidos: Juancito / Juaaan)
    for i, a in enumerate(groups):
        for b in groups[i + 1 :]:
            if a.merged or b.merged or not near(a, b):
                continue
            same_phone = a.phone and a.phone == b.phone
            ka, kb = a.name or a.nick, b.name or b.nick
            if same_phone or (ka and kb and (nick_matches(ka, b) or nick_matches(kb, a))):
                a.absorb(b, own=True)
    groups = [g for g in groups if not g.merged]

    # 5. Pistas para lo que queda: posibles duplicados que no se pudieron confirmar
    remaining = chats + groups
    for c in remaining:
        for o in remaining:
            if o is c or not near(o, c):
                continue
            label = f"{o.name or o.phone or 'sin nombre'} ({o.fecha})"
            if c.kind == o.kind == "chat" and words(c.name or "") & words(o.name or ""):
                c.hints.append(f"¿misma persona que {label}?")
            elif c.kind == "grupo" and not c.name and o.kind == "chat":
                c.hints.append(f"¿será {label}?")
        c.hints = list(dict.fromkeys(c.hints))[:3]
    return remaining


def render(cands: list[Candidate]) -> str:
    sections: dict[str, list[tuple[int, str]]] = {k: [] for k in ("contactos", "sin_agendar", "otra_persona", "grupos", "grupos_sin_nombre")}
    for c in cands:
        years = c.years
        span = f"{years[0]}" if len(years) == 1 else f"{years[0]}–{years[-1]}"
        ctx = [f'{len(years)} año{"s" if len(years) > 1 else ""} ({span})']
        if c.also_in:
            ctx.append("también en: " + ", ".join(f'"{x}"' for x in c.also_in[:4]))
        greeting = c.greeting

        if c.kind == "chat" and c.other_person:
            name = f"{c.other_person} ({c.name or c.phone})"
            line = " | ".join(x for x in (f"{name} {c.fecha}", c.phone, greeting) if x)
            sections["otra_persona"].append((len(years), f"{line}   # chat con {c.name or c.phone} · {' · '.join(ctx + c.hints)}"))
        elif c.kind == "chat" and c.agendado:
            line = " | ".join(x for x in (f"{c.name} {c.fecha}", c.phone, greeting) if x)
            sections["contactos"].append((len(years), f"{line}   # {' · '.join(ctx + c.hints)}"))
        elif c.kind == "chat":
            if c.name:
                line = " | ".join(x for x in (f"{c.name} {c.fecha}", c.phone, greeting) if x)
                ctx.insert(0, "nombre de su perfil de WhatsApp" if c.name_source == "perfil" else "nombre sacado del saludo")
            else:
                line = "# ? " + " | ".join(x for x in (c.fecha, c.phone, greeting) if x)
            sections["sin_agendar"].append((len(years), f"{line}   # {' · '.join(ctx + c.hints)}"))
        elif c.name:
            line = " | ".join(x for x in (f"{c.name} {c.fecha}", c.phone, greeting) if x)
            ctx.insert(0, "grupo " + ", ".join(f'"{x}"' for x in c.chats))
            sections["grupos"].append((len(years), f"{line}   # {' · '.join(ctx + c.hints)}"))
        else:
            ctx.insert(0, "grupo " + ", ".join(f'"{x}"' for x in c.chats))
            if c.nick:
                ctx.insert(1, f"le dijiste «{c.nick}»")
            if c.phone:
                ctx.insert(1, f"mencionaste a {c.phone}")
            sugg = [n for n, _ in c.thanks.most_common(3) if not is_id_like(n)]
            if sugg:
                ctx.insert(1, f"dijeron gracias: {', '.join(sugg)}")
            line = "# ? " + " | ".join(x for x in (c.fecha, c.phone, greeting) if x)
            sections["grupos_sin_nombre"].append((len(years), f"{line}   # {' · '.join(ctx + c.hints)}"))

    titles = {
        "contactos": "Contactos agendados",
        "sin_agendar": "Sin agendar (nombre del perfil de WhatsApp o del saludo; los '?' no tienen nombre)",
        "otra_persona": "Revisar: el saludo parece para otra persona (el número es del chat donde lo mandaste)",
        "grupos": "Saludos en grupos",
        "grupos_sin_nombre": "Saludos en grupos sin nombre (completar o borrar)",
    }
    out = [
        "# Cumpleaños detectados en WhatsApp. Formato: Nombre DD/MM | +teléfono | saludo",
        "# Revisá: borrá lo que no sirva, corregí nombres/fechas y completá los '?' (sacándoles el '#' del principio).",
        "# Lo que va después de '#' el bot lo ignora. Más años detectados = más confiable.",
        "# Ya están unidos los duplicados que se pudieron detectar ('también en: ...').",
        "# Cuando esté listo, mandale este archivo al bot por Telegram.",
        "",
    ]
    for key, items in sections.items():
        if items:
            out.append(f"# --- {titles[key]} ({len(items)}) ---")
            out.extend(line for _, line in sorted(items, key=lambda x: (-x[0], x[1].lower())))
            out.append("")
    return "\n".join(out) + "\n"


def render_style(cands: list[Candidate], samples: dict[int, deque]) -> str:
    """Ejemplos de cómo escribís: en general (tus saludos de cumple) y con cada persona (tus últimos mensajes)."""
    out = [
        "# Ejemplos de tu forma de escribir, para generar saludos con tu estilo. Archivo privado: no se sube a ningún lado.",
        "",
        "## Tus saludos de cumple en general (más recientes primero)",
    ]
    all_greetings = sorted((g for c in cands for g in c.greetings if g.own), key=lambda g: -g.ts)
    seen = set()
    for g in all_greetings:
        text = one_line(" ".join(g.parts))
        if text.lower() not in seen:
            seen.add(text.lower())
            out.append(f"- {text}")
        if len(seen) >= STYLE_GENERAL_SAMPLES:
            break
    out.append("")
    for c in sorted(cands, key=lambda c: (c.name or "~").lower()):
        label = c.name or c.phone or "?"
        if c.other_person:
            label = f"{c.other_person} ({label})"
        msgs = sorted((m for pk in c.chat_pks for m in samples.get(pk, ())), key=lambda m: -m[0])[:STYLE_SAMPLES_PER_CHAT]
        greetings = [one_line(" ".join(g.parts)) for g in sorted(c.greetings, key=lambda g: -g.ts) if g.own][:3]
        out.append(f"## {label} {c.fecha}" + (f' (grupo {", ".join(c.chats)})' if c.kind == "grupo" else ""))
        out.extend(f"- saludo: {g}" for g in greetings)
        out.extend(f"- mensaje: {m[1]}" for m in msgs)
        out.append("")
    return "\n".join(out) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backup", help="carpeta del backup (por defecto, el más reciente de esta Mac)")
    parser.add_argument("--salida", default="cumples-whatsapp.txt")
    parser.add_argument("--estilo", default="estilo-whatsapp.txt", help="archivo con ejemplos de tu forma de escribir")
    args = parser.parse_args()

    backup_path = find_backup(args.backup)
    print(f"Usando backup: {backup_path}")

    with Backup(backup_path) as backup, tempfile.TemporaryDirectory() as tmp:
        data = backup.read(WA_DOMAIN, "ChatStorage.sqlite")
        if data is None:
            die("El backup no tiene datos de WhatsApp.")
        db_path = Path(tmp) / "ChatStorage.sqlite"
        db_path.write_bytes(data)
        conn = sqlite3.connect(db_path)
        cands, total, samples = collect(conn)
        conn.close()

    final = dedupe(cands)
    print(f"Revisé {total:,} mensajes: {len(cands)} candidatos, {len(final)} personas después de unir duplicados.")
    out = Path(args.salida)
    out.write_text(render(final), encoding="utf-8")
    style = Path(args.estilo)
    style.write_text(render_style(final, samples), encoding="utf-8")
    print(f"Listo: {out.resolve()}")
    print(f"Ejemplos de estilo: {style.resolve()}")


if __name__ == "__main__":
    main()
