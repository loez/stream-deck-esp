# Cria uma sessão de mídia FALSA do Windows (SMTC) com título/artista, para o CI testar a leitura do "Tocando agora". Fica ~40 s e sai. Pode não funcionar em runners sem áudio (o teste então só avisa).
param([string]$Title = 'Faixa CI', [string]$Artist = 'Artista CI')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]
[void][Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime]
$wav = Join-Path $env:TEMP 'smtc-ci.wav'
$sr = 8000; $n = $sr * 20; $ms = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter($ms)
$w.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $w.Write([int](36 + $n)); $w.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $w.Write([int]16); $w.Write([int16]1); $w.Write([int16]1); $w.Write([int]$sr); $w.Write([int]$sr); $w.Write([int16]1); $w.Write([int16]8)
$w.Write([Text.Encoding]::ASCII.GetBytes('data')); $w.Write([int]$n); $w.Write((New-Object byte[] $n)); [IO.File]::WriteAllBytes($wav, $ms.ToArray())
$mp = [Windows.Media.Playback.MediaPlayer]::new()
$mp.CommandManager.IsEnabled = $false
$smtc = $mp.SystemMediaTransportControls; $smtc.IsEnabled = $true
$u = $smtc.DisplayUpdater; $u.Type = 1; $u.MusicProperties.Title = $Title; $u.MusicProperties.Artist = $Artist; $u.Update()
$mp.Source = [Windows.Media.Core.MediaSource]::CreateFromUri([Uri]("file:///" + $wav.Replace('\', '/')))
$mp.Play(); $smtc.PlaybackStatus = 4
Write-Host 'sessao pronta'
Start-Sleep -Seconds 40
