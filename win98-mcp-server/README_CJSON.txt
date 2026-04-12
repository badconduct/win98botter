CJSON DEPENDENCY — MANUAL DOWNLOAD REQUIRED
===========================================

cJSON.c and cJSON.h are NOT included in this repository.
They must be downloaded before building.

REASON: cJSON is a separate open-source project (MIT licence).
        Its single-file distribution is ~2,500 lines and changes
        independently of this project.

DOWNLOAD
--------
URL:  https://github.com/DaveGamble/cJSON/releases/tag/v1.7.18
Files needed:
  - cJSON.c
  - cJSON.h

Direct links:
  https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.18/cJSON.c
  https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.18/cJSON.h

QUICK METHOD (from the Win98 command prompt, if curl/wget is available):
  curl -O https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.18/cJSON.c
  curl -O https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.18/cJSON.h

Or download them on a modern PC and copy to:
  C:\WIN98BOTTER\build\win98-mcp-server\cJSON.c
  C:\WIN98BOTTER\build\win98-mcp-server\cJSON.h

WHY v1.7.18?
------------
v1.7.18 is the latest release that compiles cleanly under Visual C++ 6.0
with /W3 and C89 mode.  Newer versions may use C99 features (e.g. designated
initialisers, inline variables) that VC6 does not support.

LICENCE
-------
cJSON is MIT-licenced.  A copy of the licence is included in cJSON.h.
See https://github.com/DaveGamble/cJSON/blob/master/LICENSE

AFTER DOWNLOADING
-----------------
Place cJSON.c and cJSON.h in the same directory as mcp_server.c, then run:
  build.bat
