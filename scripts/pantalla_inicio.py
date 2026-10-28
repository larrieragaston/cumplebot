#!/usr/bin/env python3
"""
Saca de un backup local de iPhone las apps instaladas y el layout actual de la pantalla de inicio
(dock, páginas, carpetas y widgets), con el nombre y la categoría de cada app.

Los nombres y categorías se buscan en la API pública de la App Store (solo se envían los bundle IDs).

Uso (desde la raíz del proyecto):
    npm run pantalla -- --backup ~/Desktop/<carpeta-del-backup>
"""
from __future__ import annotations

import argparse
import json
import plistlib
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

from backup import Backup, die, find_backup

LOOKUP_URL = "https://itunes.apple.com/lookup"
LOOKUP_BATCH = 50

# Apps de Apple que no figuran en la App Store con su bundle ID
SYSTEM_APPS = {
    "com.apple.mobilesafari": ("Safari", "Sistema"),
    "com.apple.MobileSMS": ("Mensajes", "Sistema"),
    "com.apple.mobilephone": ("Teléfono", "Sistema"),
    "com.apple.mobilemail": ("Mail", "Sistema"),
    "com.apple.camera": ("Cámara", "Sistema"),
    "com.apple.mobileslideshow": ("Fotos", "Sistema"),
    "com.apple.Preferences": ("Configuración", "Sistema"),
    "com.apple.AppStore": ("App Store", "Sistema"),
    "com.apple.Maps": ("Mapas", "Sistema"),
    "com.apple.mobilecal": ("Calendario", "Sistema"),
    "com.apple.mobilenotes": ("Notas", "Sistema"),
    "com.apple.reminders": ("Recordatorios", "Sistema"),
    "com.apple.mobiletimer": ("Reloj", "Sistema"),
    "com.apple.weather": ("Clima", "Sistema"),
    "com.apple.Music": ("Música", "Sistema"),
    "com.apple.Health": ("Salud", "Sistema"),
    "com.apple.Passbook": ("Wallet", "Sistema"),
    "com.apple.calculator": ("Calculadora", "Sistema"),
    "com.apple.findmy": ("Buscar", "Sistema"),
    "com.apple.facetime": ("FaceTime", "Sistema"),
    "com.apple.shortcuts": ("Atajos", "Sistema"),
    "com.apple.DocumentsApp": ("Archivos", "Sistema"),
    "com.apple.podcasts": ("Podcasts", "Sistema"),
    "com.apple.tv": ("TV", "Sistema"),
    "com.apple.iBooks": ("Libros", "Sistema"),
    "com.apple.Fitness": ("Fitness", "Sistema"),
    "com.apple.Home": ("Casa", "Sistema"),
    "com.apple.Translate": ("Traducir", "Sistema"),
    "com.apple.VoiceMemos": ("Notas de voz", "Sistema"),
    "com.apple.stocks": ("Bolsa", "Sistema"),
    "com.apple.news": ("News", "Sistema"),
    "com.apple.tips": ("Consejos", "Sistema"),
    "com.apple.compass": ("Brújula", "Sistema"),
    "com.apple.measure": ("Medidas", "Sistema"),
    "com.apple.freeform": ("Freeform", "Sistema"),
    "com.apple.journal": ("Diario", "Sistema"),
    "com.apple.Passwords": ("Contraseñas", "Sistema"),
    "com.apple.Magnifier": ("Lupa", "Sistema"),
    "com.apple.Bridge": ("Watch", "Sistema"),
    "com.apple.MobileAddressBook": ("Contactos", "Sistema"),
    "com.apple.mobileme.fmf1": ("Buscar amigos", "Sistema"),
    "com.apple.MobileStore": ("iTunes Store", "Sistema"),
    "com.apple.Image-Playground": ("Image Playground", "Sistema"),
}


def lookup_names(bundle_ids: list[str]) -> dict[str, tuple[str, str]]:
    """bundle ID -> (nombre, categoría) desde la App Store (Argentina y, si falta, EE.UU.)."""
    found: dict[str, tuple[str, str]] = {}
    pending = [b for b in bundle_ids if b not in SYSTEM_APPS]
    for country in ("ar", "us"):
        missing = [b for b in pending if b not in found]
        for i in range(0, len(missing), LOOKUP_BATCH):
            batch = missing[i : i + LOOKUP_BATCH]
            query = urllib.parse.urlencode({"bundleId": ",".join(batch), "country": country, "entity": "software"})
            try:
                with urllib.request.urlopen(f"{LOOKUP_URL}?{query}", timeout=20) as res:
                    results = json.load(res).get("results", [])
            except OSError as exc:
                print(f"No pude consultar la App Store ({exc}); quedan algunos sin nombre.")
                return {**found, **SYSTEM_APPS}
            for r in results:
                if r.get("bundleId") in batch:
                    found[r["bundleId"]] = (r.get("trackName", r["bundleId"]), r.get("primaryGenreName", "?"))
    return {**found, **SYSTEM_APPS}


def describe_item(item, names: dict[str, tuple[str, str]], placed: set[str]) -> str:
    """Texto para un ícono del layout: app, carpeta, widget o pila de widgets."""
    def app(bundle: str) -> str:
        placed.add(bundle)
        return names.get(bundle, (bundle, ""))[0]

    if isinstance(item, str):
        return app(item)
    if not isinstance(item, dict):
        return "[?]"
    if "iconLists" in item:
        apps = [describe_item(i, names, placed) for page in item["iconLists"] for i in page]
        return f"📁 {item.get('displayName', 'Carpeta')}: {', '.join(apps)}"
    if "elements" in item:
        widgets = [describe_item(e, names, placed) for e in item["elements"]]
        return f"[pila de widgets: {', '.join(widgets)}]"
    container = item.get("containerBundleIdentifier") or item.get("bundleIdentifier")
    if container:
        size = item.get("gridSize", "")
        return f"[widget {size} de {names.get(container, (container, ''))[0]}]".replace("  ", " ")
    if "webClipIdentifier" in item or item.get("iconType") == "webclip":
        return f"[acceso web: {item.get('displayName', '?')}]"
    return "[otro]"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backup", help="carpeta del backup (por defecto, el más reciente de esta Mac)")
    parser.add_argument("--salida", default="pantalla-inicio.txt")
    args = parser.parse_args()

    backup_path = find_backup(args.backup)
    print(f"Usando backup: {backup_path}")

    with Backup(backup_path) as backup:
        apps = backup.installed_apps()
        raw = backup.read("HomeDomain", "Library/SpringBoard/IconState.plist") or backup.read(
            "HomeDomain", "Library/SpringBoard/DesiredIconState.plist"
        )
    if not apps and raw is None:
        die("El backup no tiene la lista de apps ni el layout de la pantalla de inicio.")
    layout = plistlib.loads(raw) if raw else {}

    all_bundles = set(apps)
    for value in layout.values():
        # Junta todos los bundle IDs que aparezcan en el layout (incluye apps de sistema)
        stack = [value]
        while stack:
            v = stack.pop()
            if isinstance(v, str) and "." in v:
                all_bundles.add(v)
            elif isinstance(v, list):
                stack.extend(v)
            elif isinstance(v, dict):
                stack.extend(v.values())
    print(f"Buscando nombres de {len(all_bundles)} apps en la App Store...")
    names = lookup_names(sorted(all_bundles))

    placed: set[str] = set()
    lines: list[str] = []
    if layout:
        dock = [describe_item(i, names, placed) for i in layout.get("buttonBar", [])]
        lines.append(f"Dock: {', '.join(dock)}\n")
        for n, page in enumerate(layout.get("iconLists", []), 1):
            lines.append(f"Página {n}:")
            lines.extend(f"  {describe_item(i, names, placed)}" for i in page)
            lines.append("")
    else:
        lines.append("(El backup no trae el layout de la pantalla de inicio; solo la lista de apps.)\n")

    library_only = sorted((names.get(b, (b, ""))[0] for b in apps if b not in placed), key=str.lower)
    lines.append(f"Solo en la biblioteca de apps ({len(library_only)}): {', '.join(library_only)}\n")

    by_genre: dict[str, list[str]] = defaultdict(list)
    for b in sorted(all_bundles):
        name, genre = names.get(b, (b, "Sin categoría"))
        by_genre[genre or "Sin categoría"].append(name)
    lines.append(f"Todas las apps por categoría ({len(all_bundles)}):")
    for genre in sorted(by_genre, key=lambda g: (-len(by_genre[g]), g)):
        lines.append(f"  {genre} ({len(by_genre[genre])}): {', '.join(sorted(by_genre[genre], key=str.lower))}")

    out = Path(args.salida)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Listo: {out.resolve()}")


if __name__ == "__main__":
    main()
