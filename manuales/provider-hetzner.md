# Provider Hetzner Cloud — Manual operativo MCP Sysadmin

Integración con la **API pública de Hetzner Cloud** (`https://api.hetzner.cloud/v1`) para gestionar servidores cloud, consultar locations, firewalls, volúmenes y ejecutar acciones de energía, unificadas bajo el modelo común de VMs del servidor MCP.

---

### 1. Resumen Ejecutivo y Propósito

- **Objetivo:** Permitir que agentes MCP operen infraestructura en Hetzner Cloud — listar servidores por región, inspeccionar detalle (CPU, RAM, disco, IP pública, labels), controlar el ciclo de energía y auditar recursos de red, firewalls y volúmenes — sin usar la consola web ni la CLI `hcloud` de forma manual.

- **Impacto estratégico:** Hetzner suele alojar cargas de producción en la UE con precio predecible. Este provider las expone con el mismo vocabulario que Proxmox y Virtualizor (`list-vms`, `vm-power`, `list-nodes`), lo que facilita runbooks multi-cloud y respuesta a incidentes desde Cursor.

- **Prerrequisitos:**
  - Entrada en inventario con `provider: "hetzner"` y `apiToken` (API token de proyecto con permisos Cloud).
  - Token con alcance suficiente: lectura de servidores, locations, firewalls y volúmenes; escritura para acciones `/servers/{id}/actions/*`.
  - `SYSADMIN_CONFIRM_TOKEN` cuando las operaciones destructivas requieran confirmación (`defaults.requireConfirm` o modo producción).
  - Opcional: `defaultLocation` (ej. `fsn1`, `nbg1`, `hel1`) para acotar listados y `get-node-status` por defecto.

> ⚠️ **Importante:** El token Bearer se envía en cada petición. Rotelo periódicamente en la consola Hetzner y referéncielo en inventario como `${HETZNER_API_TOKEN}`.

**Esquema de inventario:**

| Campo | Obligatorio | Descripción |
|-------|:-----------:|-------------|
| `id` | Sí | `hostId` en todas las tools |
| `name` | Sí | Nombre descriptivo (ej. «Hetzner Cloud») |
| `provider` | Sí | `"hetzner"` |
| `apiToken` | Sí | Token API del proyecto Hetzner Cloud |
| `defaultLocation` | No | Filtra servidores por location (`fsn1`, etc.) en `listVms` y `get-node-status` |
| `readOnly` | No | Bloquea tools no de lectura |
| `allowedTools` | No | Lista blanca por host |

---

### 2. Guía Operativa Paso a Paso

#### Paso 1: Configurar el proyecto Hetzner en el inventario

Registre un host siguiendo el ejemplo `hz-cloud` en `config/inventory.example.json`: token API, `defaultLocation` si la mayoría de servidores están en una región, y `allowedTools` con las operaciones permitidas (listados, power, firewalls, volúmenes, red, health).

Genere el token en **Hetzner Cloud Console → Security → API Tokens** con permisos de lectura y, si necesita `vm-power`, permisos de escritura sobre servidores.

#### Paso 2: Explorar locations y servidores

**Locations como «nodos»:** `list-nodes` con `hostId: "hz-cloud"` consulta `GET /locations` y `GET /servers` (paginado). Cada location se expone como nodo con `nodeId` = nombre de location (`fsn1`), nombre legible con ciudad/país, y `cpuUsage` interpretado como **ratio de servidores running / total** en esa location (no es uso de CPU del hypervisor).

**Servidores (VMs):** `list-vms` devuelve servidores Hetzner mapeados a `VmSummary`. Si el host tiene `defaultLocation` o se pasa `node` en la tool, el listado se filtra por esa location. Filtre adicional con `status`: `running`, `stopped` o `all`.

**Detalle:** `get-vm` con `vmId` numérico (ID del servidor en Hetzner) llama `GET /servers/{id}`. El objeto `raw` excluye `root_password` antes de devolver.

**Estado de location:** `get-node-status` con `nodeId` (nombre de location) devuelve métricas agregadas: `serversTotal`, `serversRunning`, más campos del nodo. Sin `nodeId`, usa `defaultLocation` del inventario; si tampoco existe, lista todas las locations.

**Recursos complementarios:**

- `list-hetzner-firewalls` → `GET /firewalls` (id, name, reglas, aplicaciones).
- `list-hetzner-volumes` → `GET /volumes` (tamaño, status, location, servidor adjunto).
- `list-network` → vista simplificada de servidores con IP y location.
- `health-check` → conteos de servidores running/stopped/en transición y estado `degraded` si hay servidores en `starting`, `stopping` o `rebuilding`.

#### Paso 3: Acciones de energía y confirmación

Use `vm-power` con `hostId`, `vmId` (ID numérico del servidor) y `action`.

**Mapeo MCP → API Hetzner Cloud:**

| Acción MCP | Endpoint Hetzner | Comportamiento |
|------------|------------------|----------------|
| `start` | `POST /servers/{id}/actions/poweron` | Enciende servidor apagado |
| `stop` | `POST /servers/{id}/actions/poweroff` | Apagado forzado (corte eléctrico virtual) |
| `shutdown` | `POST /servers/{id}/actions/shutdown` | Apagado ACPI / graceful vía guest |
| `reboot` | `POST /servers/{id}/actions/reboot` | Reinicio software |
| `reset` | `POST /servers/{id}/actions/reset` | Reset de hardware |
| `suspend` / `resume` | — | **No soportado** — error en cliente |

La respuesta incluye `hetznerAction`, `actionId` y `status` de la acción asíncrona de Hetzner.

**Confirmación:** igual que otros providers — acciones `stop`, `shutdown`, `reboot`, `reset` requieren `confirm=true` + `confirmToken` cuando `requireConfirm` está activo; con `SYSADMIN_PRODUCTION_MODE=true`, también `start`. Host `readOnly: true` bloquea cualquier `vm-power`.

> ⚠️ **Importante:** `stop` (poweroff) puede causar pérdida de datos si el SO no ha sincronizado disco. Prefiera `shutdown` para mantenimientos planificados cuando el guest responda a ACPI.

---

### 3. Anatomía y Efectos en el Sistema (Deep-Dive)

#### Arquitectura de paginación

El cliente pagina automáticamente recursos con `page` y `per_page=50`, siguiendo `meta.pagination.next_page` hasta agotar resultados. Afecta a `/servers`, `/locations`, `/firewalls` y `/volumes`.

#### Tabla completa de tools MCP

| Tool MCP | Categoría | Confirmación | API Hetzner Cloud |
|----------|-----------|:------------:|-------------------|
| `list-nodes` | lectura | No | `GET /locations` + agregación con `/servers` |
| `get-node-status` | lectura | No | Derivado de `listNodes` + `listVms(location)` |
| `list-vms` | lectura | No | `GET /servers` (filtrado por location) |
| `get-vm` | lectura | No | `GET /servers/{id}` |
| `vm-power` | destructiva | Sí* | `POST /servers/{id}/actions/{action}` |
| `list-hetzner-firewalls` | lectura | No | `GET /firewalls` |
| `list-hetzner-volumes` | lectura | No | `GET /volumes` |
| `list-network` | lectura | No | Derivado de servidores |
| `health-check` | lectura | No | `listVms` + heurística de estados |
| `list-containers` | — | — | **No aplica** (sin LXC) |
| Snapshots Proxmox | — | — | **No soportado** |

#### Normalización `VmSummary`

| Origen Hetzner | Campo MCP | Notas |
|----------------|-----------|-------|
| `server.id` | `vmId` | String decimal |
| `server.name` | `name` | |
| `server.status` | `status` | `running`, `stopped`, o transitorios (`starting`, etc.) |
| — | `type` | Siempre `kvm` |
| `datacenter.location.name` | `node` | Location |
| `server_type.cores` | `cpu` | |
| `server_type.memory` | `memoryMb` | GB × 1024 |
| `server_type.disk` | `diskGb` | |
| `public_net.ipv4.ip` | `ip` | IPv4 pública |
| `labels` | `tags` | Formato `key=value` |

#### Tabla de efectos en el sistema

| Dimensión | Impacto / Comportamiento |
| --------- | ------------------------ |
| **Herencia y Alcance** | `defaultLocation` del host filtra silenciosamente `list-vms` y define el nodo por defecto en `get-node-status`. Las políticas `readOnly` / `allowedTools` del host prevalecen sobre operaciones individuales. |
| **Visibilidad de Datos** | Labels Hetzner aparecen como tags legibles. `root_password` nunca se expone en `get-vm.raw`. Firewalls y volúmenes se listan solo vía tools dedicadas, no mezclados en `list-vms`. |
| **Ejecución y Triggers** | Las acciones de power devuelven un `action` object de Hetzner (ID y status); el servidor puede seguir en `starting`/`stopping` segundos después. `health-check` marca `degraded` mientras existan servidores en estados transitorios. No hay integración con Floating IPs, Load Balancers ni Networks privadas en el cliente actual. |

#### Limitaciones conocidas

- **Nodos ≠ servidores físicos:** `list-nodes` refleja *locations* de Hetzner, no hypervisors individuales.
- **`cpuUsage` en nodos** es proporción de servidores running, no métrica real de CPU del datacenter.
- Sin tools MCP para crear/eliminar servidores, adjuntar volúmenes o modificar firewalls.
- `list-hetzner-firewalls` y `list-hetzner-volumes` exigen `host.provider === "hetzner"`; fallan en otros hosts.

---

### 4. Preguntas Frecuentes y Solución de Problemas

#### Casos de borde

**¿Qué pasa si cambio `defaultLocation` después de desplegar servidores en otra región?**  
`list-vms` sin parámetro `node` dejará de mostrar servidores fuera de la nueva location. Use `list-vms` sin filtro temporalmente quitando `defaultLocation`, o pase `node` explícito en la invocación (el registro lo reenvía a `listVms(node)`).

**¿Puedo apagar un servidor en transición (`rebuilding`)?**  
La API puede rechazar la acción. Espere a que `health-check` deje de listar el servidor en `serversInTransition`.

**¿El servidor aparece en agregados globales?**  
Solo si `list-vms` / `list-nodes` están permitidos en `allowedTools` o no hay lista blanca.

#### Errores comunes

| Mensaje | Causa | Solución |
|---------|-------|----------|
| `Hetzner API error: …` | Token inválido, permisos o rate limit | Verifique token, scopes y cuotas en consola |
| `Hetzner server not found: {id}` | ID incorrecto o servidor en otro proyecto | Confirme ID con `list-vms` |
| `Hetzner location not found` | `nodeId` no es un nombre de location válido | Use salida de `list-nodes` (`fsn1`, `nbg1`, …) |
| `Unsupported Hetzner action: suspend` | Acción no mapeada | Use acciones soportadas |
| `Host … is not a Hetzner provider` | `hostId` apunta a otro provider | Corrija `hostId` en tools específicas de Hetzner |
| Confirmación / readOnly | Política de seguridad | Ajuste confirmación o permisos del host |

---

### 5. Ejemplos

#### Caso de uso: verificar firewalls antes de abrir un puerto

Antes de cambiar reglas en la consola Hetzner, el operador ejecuta `list-hetzner-firewalls` con `hostId: "hz-cloud"`. Revisa `rulesCount` y `appliedToCount` por firewall, correlaciona con `list-network` para IPs de servidores expuestos y documenta el cambio.

#### Caso de uso: apagado graceful de mantenimiento

Programado mantenimiento en servidor `12345678`: `vm-power` con `action: "shutdown"`, `confirm: true` y token. Hetzner envía señal ACPI; el estado pasa a `stopped`. Tras parches en consola, `action: "start"` reinicia el servicio.

#### Inventario recomendado

```json
{
  "id": "hz-cloud",
  "name": "Hetzner Cloud",
  "provider": "hetzner",
  "apiToken": "${HETZNER_API_TOKEN}",
  "defaultLocation": "fsn1",
  "readOnly": false,
  "allowedTools": [
    "list-vms",
    "get-vm",
    "vm-power",
    "list-nodes",
    "get-node-status",
    "health-check",
    "list-network",
    "list-hetzner-firewalls",
    "list-hetzner-volumes"
  ],
  "tags": ["cloud", "hetzner"]
}
```

#### Listar volúmenes huérfanos

Tras `list-hetzner-volumes`, filtre mentalmente entradas donde `server` es `undefined`: son volúmenes no adjuntos que siguen generando coste.

#### Invocación `vm-power` (shutdown)

```json
{
  "hostId": "hz-cloud",
  "vmId": "12345678",
  "action": "shutdown",
  "confirm": true,
  "confirmToken": "<SYSADMIN_CONFIRM_TOKEN>"
}
```

#### Respuesta típica de `health-check`

```json
{
  "hostId": "hz-cloud",
  "provider": "hetzner",
  "status": "healthy",
  "checks": {
    "serversTotal": 5,
    "serversRunning": 4,
    "serversStopped": 1,
    "serversInTransition": 0
  }
}
```
