# Manuales MCP Sysadmin

Documentación operativa derivada del código fuente (`src/`), generada con la metodología **Code-to-Docs Architect**.

## Índice

| Manual | Audiencia | Contenido |
|--------|-----------|-----------|
| [Manual general](./manual-general.md) | Administradores / DevOps | Instalación, inventario, seguridad, flujo con Cursor, troubleshooting |
| [Provider SSH](./provider-ssh.md) | Ops de servidores Linux | Comandos remotos, diagnóstico, allowlist, fingerprints |
| [Provider Proxmox](./provider-proxmox.md) | Virtualización on-prem | VMs LXC/KVM, snapshots, backups, tareas, storage |
| [Provider Virtualizor](./provider-virtualizor.md) | Hosting VPS | Panel Admin API, VPS, power actions |
| [Provider Hetzner Cloud](./provider-hetzner.md) | Cloud pública EU | Servidores cloud, firewalls, volúmenes |
| [Provider Cloudflare](./provider-cloudflare.md) | DNS / CDN / WAF | Zonas, registros DNS, purge cache, rulesets |

## Convenciones

- **`hostId`**: identificador único del host en `config/inventory.json`.
- **`confirmToken`**: secreto humano; el modelo MCP no lo conoce por defecto.
- **Tools read-only**: no requieren `confirmToken`.
- **Tools destructivas**: requieren `confirm: true` + `confirmToken` válido.

## Referencia rápida de tools por provider

| Tool | ssh | proxmox | virtualizor | hetzner | cloudflare |
|------|:---:|:-------:|:-----------:|:-------:|:----------:|
| Inventario (`list-hosts`, `get-host`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `list-nodes`, `get-node-status`, `health-check` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `list-vms`, `get-vm`, `vm-power` | — | ✓ | ✓ | ✓ | — |
| `list-network` | ✓ | ✓ | ✓ | ✓ | ✓ |
| Diagnóstico SSH (9 tools) | ✓ | — | — | — | — |
| Ops Proxmox (tasks, storage, backup) | — | ✓ | — | — | — |
| Ops Hetzner (firewalls, volumes) | — | — | — | ✓ | — |
| Ops Cloudflare (DNS, cache, WAF) | — | — | — | — | ✓ |
