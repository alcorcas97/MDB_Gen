@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0generate_mdb.ps1" %*
