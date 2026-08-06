# MCP Sysadmin

Servidor MCP **agnóstico de proveedor** para administrar infraestructura heterogénea: servidores físicos, VPS por SSH, clusters **Proxmox VE** y paneles **Virtualizor**.

A diferencia de MCPs atados a un hosting (p. ej. Cloudways), este proyecto usa un **inventario JSON** donde registras cada host con su proveedor y credenciales. Un mismo cliente MCP puede operar Proxmox en tu homelab, Virtualizor en un datacenter y servidores bare-metal en otra ubicación.

## Arquitectura

```mermaid
flowchart LR
  Client[Cliente MCP / Cursor] --> MCP[mcp-sysadmin]
  MCP --> Inv[(inventory.json)]
  MCP --> SSH[SSH]
  MCP --> PVE[Proxmox API]
  MCP --> VZ[Virtualizor API]
  SSH --> Physical[Servidores físicos / VPS]
  PVE --> VMs1[VMs KVM / LXC]
  VZ --> VMs2[VPS OpenVZ/KVM/Xen]
```

## Proveedores soportados

| Provider | Uso | Autenticación |
|----------|-----|---------------|
| `ssh` | Servidores físicos, VPS sin API, cualquier Linux | Clave privada o password |
| `proxmox` | Clusters / nodos Proxmox VE | API Token (`PVEAPIToken`) |
| `virtualizor` | Panel Virtualizor (Admin API) | `apiKey` + `apiPass` |

## Tools incluidos

### Inventario
- `list-hosts` — Lista hosts del inventario (filtro por provider o tag)
- `get-host` — Detalle de un host (secretos redactados)

### Nodos / métricas
- `list-nodes` — Nodos Proxmox, servidores Virtualizor, o hosts SSH
- `get-node-status` — CPU, memoria, uptime (API o SSH)

### Máquinas virtuales
- `list-vms` — VMs en Proxmox + VPS en Virtualizor
- `get-vm` — Detalle de una VM/VPS
- `vm-power` — start / stop / shutdown / reboot / reset / suspend / resume
- `list-vm-snapshots` — Snapshots Proxmox
- `create-vm-snapshot` — Crear snapshot Proxmox
- `list-proxmox-tasks` — Tareas recientes en Proxmox

### SSH (servidores físicos y genéricos)
- `ssh-exec` — Ejecutar comando remoto
- `ssh-read-file` — Leer archivo remoto

## Instalación

```bash
npm install
npm run build
```

## Configuración

1. Copia el inventario de ejemplo:

```bash
cp config/inventory.example.json config/inventory.json
```

2. Edita `config/inventory.json` con tus hosts reales.

3. Variables de entorno (opcional):

```bash
cp .env.example .env
```

```env
SYSADMIN_INVENTORY_PATH=./config/inventory.json
SYSADMIN_PRODUCTION_MODE=true
SYSADMIN_CONFIRM_TOKEN=un-secreto-largo-que-el-llm-no-conoce
SYSADMIN_READ_ONLY=false
SYSADMIN_REQUIRE_CONFIRM=true
SYSADMIN_RATE_LIMIT_MAX=30
SYSADMIN_HTTP_TIMEOUT_MS=30000
SYSADMIN_SSH_TIMEOUT_MS=30000
```

### ACL por host (inventario)

Cada host puede restringir qué tools puede usar el LLM:

```json
{
  "defaults": { "readOnly": false, "requireConfirm": true },
  "hosts": [
    {
      "id": "pve-prod",
      "readOnly": false,
      "allowedTools": ["list-vms", "get-vm", "vm-power"],
      "provider": "proxmox",
      "...": "..."
    }
  ]
}
```

- `readOnly: true` — solo tools de lectura en ese host
- `allowedTools` — lista blanca; si se omite, todas las tools del provider están permitidas

### Referencias a secretos en el inventario

Puedes usar `${VAR}` para no guardar credenciales en texto plano:

```json
{
  "tokenSecret": "${PROXMOX_HOMELAB_TOKEN}",
  "apiKey": "${VIRTUALIZOR_API_KEY}",
  "apiPass": "${VIRTUALIZOR_API_PASS}"
}
```

### Ejemplo: Proxmox

```json
{
  "id": "pve-prod",
  "name": "Proxmox Producción",
  "provider": "proxmox",
  "url": "https://10.0.0.2:8006",
  "tokenId": "root@pam!cursor-mcp",
  "tokenSecret": "${PROXMOX_TOKEN}",
  "verifySsl": false,
  "defaultNode": "pve1",
  "tags": ["production"]
}
```

Crea el token en Proxmox: **Datacenter → Permissions → API Tokens**.

### Ejemplo: Virtualizor

```json
{
  "id": "vz-panel",
  "name": "Virtualizor DC1",
  "provider": "virtualizor",
  "url": "https://panel.example.com:4085",
  "apiKey": "${VIRTUALIZOR_API_KEY}",
  "apiPass": "${VIRTUALIZOR_API_PASS}",
  "tags": ["vps"]
}
```

### Ejemplo: Servidor físico (SSH)

```json
{
  "id": "metal-01",
  "name": "Bare Metal Rack A",
  "provider": "ssh",
  "host": "203.0.113.50",
  "port": 22,
  "username": "root",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "tags": ["physical", "production"]
}
```

## Uso con Cursor

Añade en la configuración MCP de Cursor:

```json
{
  "mcpServers": {
    "sysadmin": {
      "command": "node",
      "args": ["/ruta/absoluta/mcp-sysadmin/dist/index.js"],
      "env": {
        "SYSADMIN_INVENTORY_PATH": "/ruta/absoluta/mcp-sysadmin/config/inventory.json",
        "SYSADMIN_PRODUCTION_MODE": "true",
        "SYSADMIN_CONFIRM_TOKEN": "tu-secreto-humano-no-compartir-con-el-modelo",
        "SYSADMIN_READ_ONLY": "false",
        "SYSADMIN_REQUIRE_CONFIRM": "true",
        "PROXMOX_HOMELAB_TOKEN": "tu-token",
        "VIRTUALIZOR_API_KEY": "tu-key",
        "VIRTUALIZOR_API_PASS": "tu-pass"
      }
    }
  }
}
```

Desarrollo local:

```bash
npm run dev
```

## Seguridad

### Modo producción

Activa siempre en prod:

```env
SYSADMIN_PRODUCTION_MODE=true
SYSADMIN_CONFIRM_TOKEN=<secreto-largo-aleatorio>
```

Con esto:
- SSH exige `hostKeyFingerprint` (anti-MITM) — **falla al arrancar** si falta
- **`SYSADMIN_CONFIRM_TOKEN` obligatorio** — falla al arrancar si falta
- SSH usa **allowlist** estricta (sin `cat`/`grep`; lecturas solo vía `ssh-read-file`)
- Prohibido `password` en inventario SSH
- `vm-power` requiere confirmación incluso para `start`
- Regex custom validadas (sin `.*` ni patrones demasiado amplios)

### Gate humano: `confirmToken`

El LLM puede poner `confirm: true` por prompt injection, pero **no conoce** `SYSADMIN_CONFIRM_TOKEN` (solo está en env del MCP, no en el chat):

```json
{
  "hostId": "bare-metal-01",
  "command": "systemctl status nginx",
  "confirm": true,
  "confirmToken": "tu-secreto-humano-no-compartir-con-el-modelo"
}
```

Tú proporcionas el token cuando apruebas la operación.

### Obtener fingerprint SSH

```bash
ssh-keyscan -H 10.0.0.5 | ssh-keygen -lf -
# Copia la línea SHA256:... al inventario como hostKeyFingerprint
```

### Controles implementados

| Control | Descripción |
|---------|-------------|
| **confirmToken** | Secreto humano en env MCP; el modelo no lo tiene por defecto |
| **Modo producción** | Allowlist SSH, host key pinning, sin passwords SSH |
| **Modo read-only** | `SYSADMIN_READ_ONLY=true` bloquea tools de escritura |
| **ACL por host** | `readOnly`, `allowedTools`, `allowedCommandPatterns` |
| **Allowlist SSH** | Solo diagnóstico (`systemctl status`, `journalctl`, `docker ps`, etc.) — **sin lectura de archivos** |
| **Lectura de archivos** | Exclusivamente vía `ssh-read-file` (paths + symlinks + confirmToken) |
| **cwd restringido** | Solo `/tmp`, `/var/log`, `/var/www`, `/home/*`, `/opt/*` en `ssh-exec` |
| **Regex inventario** | Patrones custom validados; prohibido `.*` y regex demasiado amplias |
| **Blocklist SSH** | Capa extra: `rm -rf`, pipes a shell, multiline, etc. |
| **Paths remotos** | `readlink -f` antes de leer; bloqueo de shadow/symlink bypass |
| **Rate limit** | 30 req/tool/host/min (configurable) |
| **TLS Proxmox** | `verifySsl` default `true` |
| **Redacción** | Secretos, configs VM, errores API filtrados |
| **Auditoría** | JSON en stderr: `[mcp-sysadmin:audit]` |

### Allowlist SSH por defecto

Incluye solo **diagnóstico operativo**: `systemctl status`, `journalctl`, `docker ps/logs`, `kubectl get`, `ls`, `df`, `free`, `nginx -t`, etc.

**No incluye** `cat`, `grep`, `head`, `tail` — usa `ssh-read-file` para leer archivos.

Añade patrones **específicos** en inventario (sin `.*`):

```json
{
  "allowedCommandPatterns": ["^systemctl restart nginx$"]
}
```

### Tools que requieren `confirm` + `confirmToken`

- `ssh-exec` — siempre
- `ssh-read-file` — siempre
- `vm-power` — todas las acciones en producción; stop/shutdown/reboot/reset siempre
- `create-vm-snapshot` — siempre

### Checklist pre-producción

- [ ] `SYSADMIN_PRODUCTION_MODE=true`
- [ ] `SYSADMIN_CONFIRM_TOKEN` generado (`openssl rand -hex 32`)
- [ ] Fingerprint SSH en cada host
- [ ] Tokens Proxmox con permisos mínimos
- [ ] `verifySsl: true` en Proxmox
- [ ] `allowedTools` por host según necesidad
- [ ] Inventario sin passwords en texto plano
- [ ] Probar una operación destructiva con token manual

## Extensión

Para añadir otro proveedor (Hetzner, oVirt, VMware, etc.):

1. Añade el provider en `src/config/schema.ts`
2. Implementa cliente en `src/providers/<nombre>/client.ts`
3. Regístralo en `src/providers/registry.ts`
4. Expone tools en `src/tools/`

La estructura sigue el patrón del [cloudways-mcp-server](https://github.com/cgmorah/cloudways-mcp-server), pero con inventario multi-proveedor en lugar de una API única.

## Desarrollo

```bash
npm run typecheck
npm run build
```
