# -*- mode: python ; coding: utf-8 -*-
#
# Build from the backend/ directory:
#   cd backend && uv run pyinstaller agent_team_backend.spec
#
# Output: backend/dist/agent_team_backend  (single executable)
# Electron copies it to resources/bin/ via package.json extraResources.

a = Analysis(
    ['run.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        # git execs GIT_ASKPASS by path (no shell), so this must exist as a
        # real file on disk in the onefile extraction dir -- PyInstaller only
        # extracts modules bundled in the PYZ archive on demand as .pyc, never
        # as the loose .py file git_service.py's GIT_ASKPASS path points to.
        ('agent_team_backend/git_askpass_helper.py', 'agent_team_backend'),
        # Plan-document infrastructure provisioned into every opened workspace
        # (<ws>/.agent-team/plans/). Read at runtime via Path(__file__).parent,
        # so onefile builds must ship the real files.
        ('agent_team_backend/plan_assets/_spec.md', 'agent_team_backend/plan_assets'),
        ('agent_team_backend/plan_assets/_template.html', 'agent_team_backend/plan_assets'),
        # Builtin backend plugins: the host discovers plugin dirs on disk
        # (plugin.json + backend.py) and imports backend.py by file path, so
        # both must exist as real files next to the extracted package.
        ('agent_team_backend/plugins/builtin/navide_plans/plugin.json',
         'agent_team_backend/plugins/builtin/navide_plans'),
        ('agent_team_backend/plugins/builtin/navide_plans/backend.py',
         'agent_team_backend/plugins/builtin/navide_plans'),
    ],
    hiddenimports=[
        # The top-level app object (imported by name in __main__.py, but listed
        # here as belt-and-suspenders for PyInstaller's graph walk).
        'agent_team_backend.app',
        # Builtin navide.plans plugin modules: its backend.py is loaded by
        # file path at runtime (never a static import), so PyInstaller's graph
        # walk cannot see these — list them (their own imports, e.g.
        # plan_meta and the MCP server modules, are then traced normally).
        'agent_team_backend.plugins.builtin.navide_plans.plan_mcp',
        'agent_team_backend.plugins.builtin.navide_plans.plan_mcp_wiring',
        # uvicorn internals that are resolved at runtime, not import-time.
        'uvicorn.main',
        'uvicorn.lifespan.on',
        'uvicorn.protocols.websockets.websockets_impl',
        'uvicorn.protocols.websockets.wsproto_impl',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.http.httptools_impl',
        'uvicorn.logging',
        'uvicorn.loops.asyncio',
        'uvicorn.loops.uvloop',
        # uvicorn[standard] optional extras.
        'websockets',
        'websockets.legacy',
        'websockets.legacy.server',
        'httptools',
        'watchfiles',
        # watchdog: macOS FSEvents backend + polling fallback.
        'watchdog.observers.fsevents',
        'watchdog.observers.polling',
        # anthropic SDK uses lazy internal imports.
        'anthropic',
        'anthropic._streaming',
        # httpx (used by anthropic and fastapi test clients).
        'httpx',
        # MCP SDK.
        'mcp',
        'mcp.server',
        'mcp.server.stdio',
        'mcp.client',
        'mcp.client.stdio',
        # pydantic v2 validators loaded via plugin mechanism.
        'pydantic.deprecated.class_validators',
        'pydantic.deprecated.config',
        'pydantic.deprecated.tools',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Dev-only; never needed at runtime.
        'pytest',
        'pytest_asyncio',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='agent_team_backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    # argv_emulation=True causes PTY issues on macOS; keep it off.
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
