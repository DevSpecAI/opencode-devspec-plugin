@echo off
setlocal EnableExtensions
set "DIR=%~dp0"
set "HANDLER=%DIR%open-handler.mjs"
set "EXE=%DIR%bin\devspec-open-handler.exe"
rem Never put percent-tilde-1 in rem lines: cmd expands it and breaks the comment.
rem Unquote the protocol URL, then re-quote when calling node/exe.
set "URL=%~1"

where node >nul 2>&1
if errorlevel 1 goto try_exe
node "%HANDLER%" --url "%URL%"
exit /b %ERRORLEVEL%

:try_exe
if not exist "%EXE%" goto missing
"%EXE%" --url "%URL%"
exit /b %ERRORLEVEL%

:missing
echo DevSpec handler requires Node.js or devspec-open-handler.exe>&2
exit /b 1
