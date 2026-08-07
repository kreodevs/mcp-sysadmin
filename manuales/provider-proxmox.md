# Provider Proxmox — Manual Operativo

Documentación derivada del código en `src/providers/proxmox/client.ts`, `src/tools/vms.ts`, `src/tools/proxmox-ops.ts`, `src/tools/nodes.ts`, `src/providers/health.ts`, `src/security/policy.ts` y `src/config/schema.ts`.

---

### 1. Resumen Ejecutivo y Propósito

**Objetivo:** El provider Proxmox integra el hypervisor on-premises con el servidor MCP Sysadmin mediante la API REST de Proxmox VE (`/api2/json`). Permite inventariar nodos y VMs (KVM/qemu y LXC), consultar métricas, gestionar energía de VMs, snapshots, backups vzdump, almacenamiento, tareas asíncronas y configuración de red — todo desde el mismo flujo conversacional que SSH o Hetzner Cloud. El valor estratégico es operar virtualización privada con las mismas salvaguardas de confirmación humana, auditoría, rate limiting y modo solo lectura que el resto del inventario.

**Prerrequisitos:**

| Requisito | Detalle |
|-----------|---------|
| **Cluster Proxmox VE** | Accesible vía HTTPS (típicamente puerto 8006). |
| **API Token** | Token de API PVE con permisos acordes a las operaciones (`tokenId` + `tokenSecret`). Formato: `usuario@realm!nombre-token`. |
| **Inventario** | Entrada `provider: "proxmox"` validada por `ProxmoxHostSchema`. |
| **Nodo por defecto (recomendado)** | `defaultNode` evita especificar `node` en cada tool en clusters de un solo nodo o nodo habitual. |
| **Token de confirmación** | `SYSADMIN_CONFIRM_TOKEN` para tools destructivas (`vm-power`, `create-vm-snapshot`, `create-backup`). |
| **SSL** | `verifySsl: true` por defecto; en producción, `verifySsl=false` genera advertencia de seguridad. |

Campos del host Proxmox en inventario:

| Campo | Obligatorio | Descripción |
|-------|:-----------:|-------------|
| `id`, `name`, `provider` | Sí | Identificador MCP, nombre legible y `"proxmox"`. |
| `url` | Sí | URL base del panel, p. ej. `https://192.168.1.10:8006`. |
| `tokenId`, `tokenSecret` | Sí | Credenciales API (`Authorization: PVEAPIToken=...`). Soporta `${ENV_VAR}`. |
| `verifySsl` | No | Default `true`. Agente HTTPS con `rejectUnauthorized`. |
| `defaultNode` | No | Nodo Proxmox por defecto para operaciones que requieran `node`. |
| `readOnly` | No | Solo tools categoría `read`. |
| `allowedTools` | No | Lista blanca de tools permitidas en este host. |
| `tags`, `description` | No | Metadatos. |

Ejemplo de inventario (`config/inventory.example.json`):

```json
{
  "id": "pve-homelab",
  "name": "Proxmox Homelab",
  "provider": "proxmox",
  "url": "https://192.168.1.10:8006",
  "tokenId": "root@pam!mcp-token",
  "tokenSecret": "${PROXMOX_HOMELAB_TOKEN}",
  "verifySsl": true,
  "allowedTools": [
    "list-vms", "get-vm", "vm-power", "list-nodes", "get-node-status",
    "list-vm-snapshots", "create-vm-snapshot", "list-proxmox-tasks"
  ],
  "tags": ["homelab", "virtualization"]
}
```

> ⚠️ **Importante:** El token API debe tener permisos mínimos necesarios (principio de least privilege). Un token con rol `Administrator` habilita todas las operaciones que el inventario no restrinja con `allowedTools` o `readOnly`.

---

### 2. Guía Operativa Paso a Paso

#### Paso 1: Crear token API en Proxmox y registrar el host

En la interfaz Proxmox (Datacenter → Permissions → API Tokens), cree un token dedicado para MCP con permisos acotados (p. ej. `VM.PowerMgmt`, `VM.Snapshot`, `Sys.Audit` según necesidad). Registre `url`, `tokenId` y `tokenSecret` en `config/inventory.json`. Use variables de entorno para el secreto (`${PROXMOX_HOMELAB_TOKEN}`) en lugar de valores en claro.

Si el cluster tiene un solo nodo o un nodo principal, configure `defaultNode` con el nombre exacto del nodo Proxmox (como aparece en `list-nodes`). Sin `defaultNode`, toda tool que opere sobre una VM concreta exigirá el parámetro `node` explícito; de lo contrario, `ProxmoxClient.resolveNode()` lanzará error.

#### Paso 2: Delimitar alcance con `allowedTools` y `readOnly`

Proxmox expone operaciones de alto impacto (apagar VMs, vzdump, snapshots). Use `allowedTools` para limitar qué capacidades ve el agente en cada host. Por ejemplo, un host de observabilidad puede listar VMs y tareas pero excluir `vm-power` y `create-backup`.

Con `readOnly: true`, quedan disponibles consultas (`list-vms`, `get-vm`, `list-storage-usage`, etc.) pero se bloquean `vm-power`, `create-vm-snapshot` y `create-backup` por categoría en `TOOL_CATEGORIES`.

Las operaciones destructivas además requieren confirmación humana:

- **`confirm: true`** en la invocación MCP.
- **`confirmToken`** coincidente con `SYSADMIN_CONFIRM_TOKEN`.

En producción (`SYSADMIN_PRODUCTION_MODE=true`), `vm-power` con acciones no destructivas (`start`) también exige confirmación si el modo producción está activo (`needsConfirm = destructive || isProductionMode()`).

#### Paso 3: Operar VMs y tareas asíncronas

Las mutaciones en Proxmox son **asíncronas**: `vm-power`, `create-vm-snapshot` y `create-backup` devuelven un **`taskId` (UPID)**, no el resultado final inmediato. El flujo operativo correcto es:

1. Invocar la operación con confirmación → obtener `taskId`.
2. Consultar `get-proxmox-task` con `upid` y `node` hasta que `status` indique finalización.
3. Verificar estado de la VM con `get-vm` o listado con `list-vms`.

Para consultas de inventario sin mutación, use `list-vms` (opcionalmente filtrado por `hostId`, `node`, `status`) o `get-vm` para detalle de una VM concreta. Especifique `vmType: "lxc"` para contenedores LXC; el default es `"qemu"` (KVM).

`get-vm` devuelve `config` y `statusRaw` **sanitizados** (`sanitizeProxmoxVmPayload`) para ocultar campos sensibles de la configuración Proxmox antes de exponerlos al agente.

---

### 3. Anatomía y Efectos en el Sistema (Deep-Dive)

| Dimensión | Impacto / Comportamiento |
|-----------|--------------------------|
| **Herencia y Alcance** | `defaults.readOnly` y `defaults.requireConfirm` aplican globalmente. `allowedTools` y `readOnly` son por host Proxmox. `defaultNode` afecta a todas las tools que llaman `resolveNode()` sin `node` explícito. `SYSADMIN_READ_ONLY=true` bloquea mutaciones en todo el inventario. |
| **Visibilidad de Datos** | Las respuestas incluyen resúmenes tipados (`VmSummary`, `NodeSummary`), UPIDs de tareas, porcentajes de storage y interfaces de red. Configuración de VM sensible se redacta en `get-vm`. Errores API Proxmox se propagan como `SysadminError` con status HTTP y cuerpo JSON de errores PVE. |
| **Ejecución y Triggers** | Cliente HTTP axios con timeout `SYSADMIN_HTTP_TIMEOUT_MS`. Mutaciones POST a endpoints `/nodes/{node}/{qemu\|lxc}/{vmid}/status/{action}`, `/snapshot`, `/vzdump`. Side effects reales ocurren en el hypervisor: VMs cambian de estado, se crean snapshots en storage configurado, vzdump consume I/O y espacio en el datastore destino. El proceso MCP no mantiene conexión persistente; cada tool es una o más peticiones REST. |

#### Tools del provider Proxmox — referencia completa

##### Inventario de VMs

| Tool | Categoría | Parámetros | Comportamiento |
|------|-----------|------------|----------------|
| **`list-vms`** | read | `hostId?`, `node?`, `status?` (`all`\|`running`\|`stopped`) | Lista VMs qemu y LXC. Sin `hostId`, agrega todos los hypervisors del inventario. Filtra por estado si se indica. |
| **`list-containers`** | read | `hostId?`, `node?`, `status?` | Igual que `list-vms` filtrado a `type === "lxc"`. |
| **`get-vm`** | read | `hostId`*, `vmId`*, `node?`, `vmType?` (`qemu`\|`lxc`) | Detalle: status, config (sanitizada), CPU, memoria, disco, tags. |

##### Energía y snapshots

| Tool | Categoría | Parámetros | Comportamiento |
|------|-----------|------------|----------------|
| **`vm-power`** | destructive | `hostId`*, `vmId`*, `action`*, `node?`, `vmType?`, `confirm?`, `confirmToken?` | Acciones: `start`, `stop`, `shutdown`, `reboot`, `reset`, `suspend`, `resume`. POST a API status. Retorna `taskId`. |
| **`list-vm-snapshots`** | read | `hostId`*, `vmId`*, `node?`, `vmType?` | Lista snapshots con nombre, descripción, timestamp. |
| **`create-vm-snapshot`** | destructive | `hostId`*, `vmId`*, `snapname`*, `description?`, `node?`, `vmType?`, `confirm?`, `confirmToken?` | Crea snapshot. Retorna `taskId`. |

##### Tareas, storage y backups

| Tool | Categoría | Parámetros | Comportamiento |
|------|-----------|------------|----------------|
| **`list-proxmox-tasks`** | read | `hostId`*, `node?`, `limit?` (default 50, max 200) | Tareas recientes del cluster o de un nodo. |
| **`get-proxmox-task`** | read | `hostId`*, `upid`*, `node?` | Estado de tarea: `status`, `exitstatus`, `type`, tiempos. |
| **`list-storage-usage`** | read | `hostId`*, `node?` | Sin `node`: storages del cluster. Con `node`: storages del nodo. Incluye uso y porcentaje. |
| **`list-backups`** | read | `hostId`*, `node?`, `limit?` (default 30, max 100) | Filtra tareas tipo `vzdump`/`backup` de `listTasks`. |
| **`create-backup`** | destructive | `hostId`*, `vmId`*, `node?`, `vmType?`, `storage?`, `mode?` (`snapshot`\|`suspend`\|`stop`), `confirm?`, `confirmToken?` | Inicia vzdump. Default `mode: snapshot`. Retorna `taskId`. |

##### Nodos, red y salud

| Tool | Categoría | Parámetros | Comportamiento |
|------|-----------|------------|----------------|
| **`list-nodes`** | read | `hostId?` | Nodos Proxmox con CPU, memoria, uptime, status. |
| **`get-node-status`** | read | `hostId`*, `nodeId?` | Métricas del nodo; usa `defaultNode` si no se pasa `nodeId`. |
| **`list-network`** | read | `hostId`*, `node?` | Interfaces del nodo: tipo, dirección, gateway, bridge. |
| **`health-check`** | read | `hostId?` | Marca `degraded` si hay nodos offline; incluye conteo VMs running/total. |

> ⚠️ **Importante:** Tools como `list-vms` y `vm-power` también funcionan con providers Virtualizor y Hetzner cuando se pasa su `hostId`. Este manual documenta el comportamiento **específico de Proxmox**; invoque siempre con `hostId` de un host `provider: "proxmox"`.

#### Resolución de nodo (`resolveNode`)

Orden de precedencia:

1. Parámetro `node` / `nodeId` explícito en la tool.
2. `defaultNode` del inventario.
3. Error: *"Node is required for Proxmox host X. Provide 'node' or set defaultNode in inventory."*

#### Acciones vm-power soportadas en Proxmox

| Acción | Efecto en el hypervisor |
|--------|-------------------------|
| `start` | Enciende VM detenida |
| `stop` | Apagado forzado (equivalente a botón power) |
| `shutdown` | Apagado ACPI/graceful vía guest agent |
| `reboot` | Reinicio |
| `reset` | Reset hard |
| `suspend` | Suspende VM (qemu) |
| `resume` | Reanuda VM suspendida |

#### Modos de backup vzdump

| Modo | Comportamiento |
|------|----------------|
| `snapshot` | Backup en caliente con snapshot (default) |
| `suspend` | Suspende VM durante backup |
| `stop` | Detiene VM durante backup |

---

### 4. Preguntas Frecuentes y Solución de Problemas

**¿Por qué "Node is required for Proxmox host"?**

No se proporcionó `node` en la tool y el host no tiene `defaultNode`. Añada `defaultNode` al inventario o pase `node` en cada invocación que opere sobre VMs.

**¿Por qué `get-vm` falla con error Proxmox API 403/401?**

El token API carece de permisos para leer esa VM o nodo. Revise roles PVE del token en Datacenter → Permissions.

**¿Cómo sé si un snapshot o backup terminó?**

Las operaciones devuelven UPID. Use `get-proxmox-task`:

```json
{
  "hostId": "pve-homelab",
  "node": "pve",
  "upid": "UPID:pve:00012345:..."
}
```

Consulte hasta `status: "stopped"` y verifique `exitstatus`.

**¿`vm-power` con `start` requiere confirmación?**

En desarrollo, solo acciones destructivas (`stop`, `shutdown`, `reboot`, `reset`) exigen confirmación por defecto. En **`SYSADMIN_PRODUCTION_MODE=true`**, **todas** las acciones incluyendo `start` requieren `confirm` + token.

**¿Por qué `Snapshots are only supported on Proxmox hosts`?**

`list-vm-snapshots` y `create-vm-snapshot` validan `host.provider === "proxmox"`. No aplican a Virtualizor ni Hetzner.

**¿Qué implica `verifySsl: false`?**

El cliente acepta certificados autofirmados (útil en lab). En producción genera advertencia `[mcp-sysadmin:warn] PRODUCTION: Proxmox host 'X' has verifySsl=false`.

**Casos de borde:**

- **VM en nodo distinto al `defaultNode`:** debe pasar `node` explícito o la API devolverá 404/500.
- **LXC vs qemu:** operaciones sobre contenedor LXC requieren `vmType: "lxc"`; default es KVM.
- **`list-vms` sin hostId:** agrega VMs de Proxmox, Virtualizor y Hetzner; filtre por `hostId` para aislar Proxmox.
- **Storage lleno en vzdump:** la tarea fallará; `get-proxmox-task` mostrará `exitstatus` de error; revise `list-storage-usage`.
- **Host `readOnly` con `vm-power` en `allowedTools`:** bloqueado igualmente por categoría destructive vs readOnly.

**Errores comunes:**

| Mensaje | Causa | Acción |
|---------|-------|--------|
| `Proxmox API error: ...` | Error REST PVE | Revisar permisos, existencia VM/nodo, conectividad |
| `Tool 'vm-power' blocked: host 'X' is readOnly` | Host solo lectura | Quitar readOnly o usar otro host |
| `Confirmación requerida para 'create-backup'` | Falta confirmación | Reintentar con `confirm: true` y token |
| `Host not found in inventory` | `hostId` incorrecto | Verificar inventario |
| `Unsupported Proxmox action` | Acción no válida | Usar una de las siete acciones soportadas |

---

### 5. Ejemplos

#### Caso de uso: Inventario matutino del homelab

Verificar salud general y VMs detenidas:

```json
{ "hostId": "pve-homelab" }
```

1. `health-check` → nodos online, VMs running/total.
2. `list-vms` con `status: "stopped"` → identificar VMs apagadas inesperadamente.
3. `list-systemd-units` no aplica a Proxmox; use `list-proxmox-tasks` para tareas recientes fallidas.

#### Caso de uso: Arrancar VM de desarrollo

En producción, incluir confirmación:

```json
{
  "hostId": "pve-homelab",
  "vmId": "105",
  "action": "start",
  "node": "pve",
  "vmType": "qemu",
  "confirm": true,
  "confirmToken": "<SYSADMIN_CONFIRM_TOKEN>"
}
```

Tool: `vm-power`. Seguimiento:

```json
{
  "hostId": "pve-homelab",
  "vmId": "105",
  "node": "pve"
}
```

Tool: `get-vm` → confirmar `status: "running"`.

#### Caso de uso: Snapshot antes de actualización de SO

```json
{
  "hostId": "pve-homelab",
  "vmId": "105",
  "snapname": "pre-upgrade-2026-08-06",
  "description": "Antes de apt upgrade",
  "node": "pve",
  "confirm": true,
  "confirmToken": "<SYSADMIN_CONFIRM_TOKEN>"
}
```

Tool: `create-vm-snapshot`. Listar snapshots existentes:

```json
{
  "hostId": "pve-homelab",
  "vmId": "105",
  "node": "pve"
}
```

Tool: `list-vm-snapshots`.

#### Caso de uso: Backup vzdump nocturno manual

```json
{
  "hostId": "pve-homelab",
  "vmId": "105",
  "node": "pve",
  "storage": "local",
  "mode": "snapshot",
  "confirm": true,
  "confirmToken": "<SYSADMIN_CONFIRM_TOKEN>"
}
```

Tool: `create-backup`. Monitorear:

```json
{
  "hostId": "pve-homelab",
  "upid": "UPID:pve:000ABCDEF:...",
  "node": "pve"
}
```

Tool: `get-proxmox-task`. Histórico:

```json
{ "hostId": "pve-homelab", "limit": 20 }
```

Tool: `list-backups`.

#### Caso de uso: Capacidad de storage antes de migración

```json
{ "hostId": "pve-homelab" }
```

Tool: `list-storage-usage` (cluster completo). Para un nodo:

```json
{ "hostId": "pve-homelab", "node": "pve" }
```

#### Caso de uso: Auditar red del nodo

```json
{ "hostId": "pve-homelab", "node": "pve" }
```

Tool: `list-network` → bridges, IPs y gateways configurados en Proxmox.

#### Caso de uso: Listar solo contenedores LXC

```json
{
  "hostId": "pve-homelab",
  "node": "pve"
}
```

Tool: `list-containers` → equivalente a filtrar LXC sin VMs KVM.

#### Ejemplo de host con alcance restringido

El ejemplo `pve-homelab` limita tools a operaciones de VM y observabilidad, excluyendo `create-backup` y `list-storage-usage`. Cualquier invocación a tool no listada produce:

> `Tool 'create-backup' not in allowedTools for host 'pve-homelab': [list-vms, get-vm, ...]`

Amplíe `allowedTools` solo cuando el flujo operativo lo requiera.
