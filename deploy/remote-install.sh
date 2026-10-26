# Runs on the target machine, piped over SSH by deploy.sh. Safe to run repeatedly.
# Layout: ~/kondo/{node, releases/<release>, current -> releases/<release>, config, data}
set -euo pipefail
: "${RELEASE:?}" "${NODE_VERSION:?}" "${KONDO_PORT:?}"
KONDO="$HOME/kondo"
mkdir -p "$KONDO/releases" "$KONDO/config" "$KONDO/data"

# 1. Kondo's own Node. The system Node is too old and is left untouched.
if [ "$("$KONDO/node/bin/node" --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  echo "    installing Node $NODE_VERSION"
  tmp="$(mktemp -d)"
  file="node-$NODE_VERSION-linux-x64.tar.xz"
  base="https://nodejs.org/dist/$NODE_VERSION"
  curl -fsSL -o "$tmp/$file" "$base/$file"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -)
  tar -xJf "$tmp/$file" -C "$KONDO"
  ln -sfn "$KONDO/node-$NODE_VERSION-linux-x64" "$KONDO/node"
  rm -rf "$tmp"
fi

# 2. Settings: created once, then only ever edited by hand on this machine.
if [ ! -f "$KONDO/config/kondo.env" ]; then
  (
    umask 077
    printf 'KONDO_PORT=%s\nKONDO_DATA_DIR=%s\n' "$KONDO_PORT" "$KONDO/data" >"$KONDO/config/kondo.env"
  )
fi

# 3. Point `current` at the new release in one step.
ln -sfn "releases/$RELEASE" "$KONDO/current.new"
mv -T "$KONDO/current.new" "$KONDO/current"

# 4. User-level systemd service, enabled so it starts at boot.
mkdir -p "$HOME/.config/systemd/user"
install -m 644 "$KONDO/current/kondo.service" "$HOME/.config/systemd/user/kondo.service"
systemctl --user daemon-reload
systemctl --user enable --quiet kondo.service
systemctl --user restart kondo.service
if ! loginctl show-user "$USER" --property=Linger | grep -q "=yes"; then
  echo "    WARNING: lingering is off, so Kondo won't start at boot. Run once: sudo loginctl enable-linger $USER"
fi

# 5. Wait for it to answer.
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$KONDO_PORT/api/health" >/dev/null 2>&1; then
    echo "    running release $RELEASE"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "    Kondo did not start. Recent logs:"
    journalctl --user --unit kondo --lines 30 --no-pager
    exit 1
  fi
  sleep 1
done

# 6. Keep the five newest releases.
find "$KONDO/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +6 |
  cut -d' ' -f2- | xargs -r rm -rf
