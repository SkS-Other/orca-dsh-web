# DSH Web

[Русская версия](README.ru.md)

An Orca plugin: keeps one DeepSeek Harness host per project and profile and opens
the Web UI in an Orca tab.

- The footer has a single **DSH** button: it opens a panel with all profiles from
  `$DSH_HOME/profiles` (default `~/.dsh/profiles`). A new profile appears in the
  panel after "Refresh", without reloading the plugin.
- For each profile the panel shows the status, the URL and an "Open" button; a
  running profile also gets a stop icon next to it. Opening brings the host up if
  it is not running yet, and creates a project tab.
- Commands in the palette: "profiles", "open (web)", "open (unity)",
  "stop project", "stop all".
- Hosts do not get in each other's way: each project has its own tmux session
  `orca-dsh-web-<hash>` and its own port (`--port 0`), so `split` on unity and
  `lilly_web` on web can run at the same time.
- The status bar shows the number of live hosts of the current project; green
  means at least one profile is running.
- Launching again reuses a live host; there can be several tabs.
- **Auto-stop**: when all tabs with the host's address are closed, the host is
  shut down after `stopAfterSeconds` (60 s by default, `0` — never). The countdown
  starts only after the plugin has seen the tab at least once, so a DSH opened in
  a regular browser is unaffected.
- Logs: `~/.cache/orca-dsh-web/dsh-web-<hash>.log`; manually — `tmux attach -t orca-dsh-web-<hash>`.

Settings: `command` (`dsh web --no-open --port 0`), `unityCommand`
(`dsh unity --no-open --port 0`), `stopAfterSeconds`.

Limitations:

- Works on the local host only: for a remote workspace tmux is unavailable.
- DSH lives in tmux, not in the Orca terminal, so the standard hooks and the DSH status in Orca do not work.
- Requires `tmux` to be installed.
- Each host is a separate DSH process: keep only the projects you need open.

Orca does not let plugins add a row to the agents list: the plugin does not
replace the built-in DeepSeek Harness row (it launches `dsh-tui`) but adds its own
panel and status bar.

## Validation

```sh
orca-ide plugin validate .
orca-ide plugin test .
orca-ide plugin check .
```
