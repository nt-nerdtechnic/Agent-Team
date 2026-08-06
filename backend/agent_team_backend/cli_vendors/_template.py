"""CONTRIBUTOR TEMPLATE — copy to ``<your_key>.py`` and fill in.

Files starting with ``_`` are ignored by the registry and its tests. Steps to
add a vendor (full guide: ``docs/adding-a-cli-vendor.md``):

1. Copy this file to ``<key>.py`` (short lowercase key, e.g. ``mycli``).
2. Fill in SPEC below. Leave any capability at its default until you
   implement it — ``None`` means the app treats that capability as
   unsupported for your vendor (it does NOT fall back to another vendor).
3. Register the SPEC in ``registry.py`` (one line, alphabetical).
4. Add a log reader section below if your CLI writes local conversation
   logs, plus ``backend/tests/vendors/test_<key>.py``.
5. Add the frontend spec in ``src/renderer/src/agents/<key>.ts`` and
   register it in ``agents/index.ts``.
6. Run the structural tests — they tell you what is missing or forbidden:
   ``uv --project backend run pytest backend/tests/test_cli_vendors_registry.py``

Import rules (CI-enforced): only ``base``, ``_protocols``, the standard
library, and httpx. Never import another vendor module or any app/ws/vault
module.
"""

from .base import VendorSpec

SPEC = VendorSpec(
    key="_template",          # your vendor key — must match the filename
    label="Human Name",       # display label, e.g. "MyCLI"
    # --- credentials: only if the CLI stores a login the vault can park ---
    # live_file=(".mycli", "auth.json"),
    # slot_file="auth.json",
    # login_home_secret_file=(".mycli", "auth.json"),
    # profile_home_secret_file=(".mycli", "auth.json"),
    # --- usage quota: async (home) -> snapshot dict ---
    # fetch_usage=fetch_usage,
    # --- resume / session ---
    # resume_id_from_command=resume_id_from_command,
    # session_path=session_path,
    # session_exists=session_exists,
    # --- spawn environment ---
    # home_env_vars=("MYCLI_HOME",),
    # interrupt_key=b"\x03",
    # --- log reading ---
    # make_log_reader=lambda: MyCliLogReader(),
)
