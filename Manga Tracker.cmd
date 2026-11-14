@echo off
rem Starts Manga Tracker: a small local server (Node) that opens in your browser.
title Manga Tracker
cd /d "%~dp0"
if not exist "dist-server\server.js" call npm run build
node "dist-server\server.js"
if errorlevel 1 pause
