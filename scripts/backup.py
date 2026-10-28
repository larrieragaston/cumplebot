"""Acceso de solo lectura a un backup local de iPhone (encriptado o no), compartido por los scripts."""
from __future__ import annotations

import getpass
import plistlib
import sqlite3
import sys
from pathlib import Path

BACKUP_ROOT = Path.home() / "Library/Application Support/MobileSync/Backup"


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def find_backup(arg: str | None) -> Path:
    if arg:
        path = Path(arg).expanduser()
        if not (path / "Manifest.plist").exists():
            die(f"{path} no parece un backup de iPhone (no tiene Manifest.plist).")
        return path
    try:
        backups = [p for p in BACKUP_ROOT.iterdir() if (p / "Manifest.plist").exists()]
    except FileNotFoundError:
        die(f"No hay backups de iPhone en {BACKUP_ROOT}. Hacé uno desde Finder (ver README).")
    except PermissionError:
        die(
            "macOS no deja leer la carpeta de backups. Copiá el backup a otro lado desde Finder\n"
            "(Finder → tu iPhone → Administrar backups → clic derecho → Mostrar en Finder → copiar la carpeta)\n"
            "y pasá la ruta con --backup."
        )
    if not backups:
        die(f"No hay backups de iPhone en {BACKUP_ROOT}.")
    return max(backups, key=lambda p: (p / "Manifest.plist").stat().st_mtime)


class Backup:
    """Lee archivos puntuales del backup. Si está encriptado, pide la contraseña una sola vez."""

    def __init__(self, path: Path):
        self.path = path
        with (path / "Manifest.plist").open("rb") as f:
            self.manifest = plistlib.load(f)
        self.encrypted = bool(self.manifest.get("IsEncrypted"))
        self._decrypted = None

    def installed_apps(self) -> list[str]:
        """Bundle IDs de las apps instaladas (no incluye las de sistema)."""
        return sorted(self.manifest.get("Applications", {}))

    def read(self, domain_like: str, relative_path: str) -> bytes | None:
        if not self.encrypted:
            with sqlite3.connect(f"file:{self.path / 'Manifest.db'}?mode=ro", uri=True) as manifest:
                row = manifest.execute(
                    "SELECT fileID FROM Files WHERE domain LIKE ? AND relativePath = ? AND flags = 1 LIMIT 1",
                    (domain_like, relative_path),
                ).fetchone()
            return (self.path / row[0][:2] / row[0]).read_bytes() if row else None
        try:
            return self._unlock().extract_file_as_bytes(relative_path, domain_like=domain_like)
        except FileNotFoundError:
            return None

    def _unlock(self):
        if self._decrypted is None:
            try:
                from iphone_backup_decrypt import EncryptedBackup
            except ImportError:
                die("Falta la librería para backups encriptados. Corré el script con npm (ver README).")
            if not sys.stdin.isatty():
                die(
                    "Necesito pedirte la contraseña del backup y esta consola no lo permite.\n"
                    "Corré el comando en una terminal normal (la de Cursor o la app Terminal)."
                )
            password = getpass.getpass("Contraseña del backup encriptado (no se muestra ni se guarda): ")
            print("Desbloqueando el backup (puede tardar un minuto)...")
            try:
                self._decrypted = EncryptedBackup(backup_directory=str(self.path), passphrase=password)
                self._decrypted.test_decryption()
            except Exception as exc:  # la librería usa varias excepciones propias
                die(f"No pude desencriptar el backup: {exc}. ¿La contraseña es correcta?")
        return self._decrypted

    def close(self) -> None:
        if self._decrypted is not None:
            # Borra la copia temporal desencriptada del Manifest que crea la librería
            self._decrypted._cleanup()
            # Evita que la librería intente limpiar de nuevo al destruirse (y falle porque ya no existe)
            self._decrypted._temp_manifest_db_conn = None
            self._decrypted._temporary_folder = None
            self._decrypted = None

    def __enter__(self) -> "Backup":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
