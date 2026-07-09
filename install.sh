#!/usr/bin/env bash
# Instalador de Megazord desde el código fuente (macOS / Linux).
# Copia los comandos a un directorio de tu PATH (~/.local/bin por defecto).
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${MEGAZORD_BIN:-$HOME/.local/bin}"
mkdir -p "$BIN"

echo "🦖 Instalando Megazord en $BIN ..."

# el motor
ln -sf "$HERE/bin/council-dev.js" "$BIN/council-dev"
chmod +x "$HERE/bin/council-dev.js"

# los comandos
for f in megazord megazord-multi power-chamber power-chamber-local megazord-chamber megazord-iniciate; do
  if [ -f "$HERE/scripts/$f" ]; then
    chmod +x "$HERE/scripts/$f"
    ln -sf "$HERE/scripts/$f" "$BIN/$f"
  fi
done

echo "✓ Listo."
case ":$PATH:" in
  *":$BIN:"*) : ;;
  *) echo "⚠️  Agrega $BIN a tu PATH:  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.bashrc" ;;
esac
echo
echo "Prueba:  megazord doctor"
