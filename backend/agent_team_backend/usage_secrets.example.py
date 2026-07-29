"""Local, untracked constants for usage_service.py.

Antigravity's OAuth client credentials are its *public* installed-app OAuth
constants — the same values that ship in Antigravity's open-source auth plugin,
and (per RFC 8252) not confidential for a native/installed app. Even so, we do
not commit them to this open-source repo: GitHub secret-scanning flags the
pattern, and embedding third-party credentials in a public repo is poor
hygiene.

To enable the Antigravity quota provider locally or in a release build:

    cp usage_secrets.example.py usage_secrets.py
    # then paste the real public constants into usage_secrets.py

``usage_secrets.py`` is gitignored (see .gitignore) and picked up automatically
by ``usage_service.py`` and the PyInstaller build. When it is absent the
provider degrades gracefully (token refresh returns 401 -> status "error").
"""

ANTIGRAVITY_CLIENT_ID = ""
ANTIGRAVITY_CLIENT_SECRET = ""
