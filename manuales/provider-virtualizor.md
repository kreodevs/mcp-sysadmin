# Provider Virtualizor — Manual operativo MCP Sysadmin

Integración con paneles **Virtualizor** (Admin API JSON) para inventariar nodos físicos, listar VPS, consultar detalle y ejecutar acciones de energía desde herramientas MCP, con políticas de confirmación y sanitización de datos sensibles.

---

### 1. Resumen Ejecutivo y Propósito

- **Objetivo:** Conectar el servidor MCP Sysadmin a un panel Virtualizor existente y exponer operaciones de lectura y control de energía sobre VPS (KVM, Xen, OpenVZ) sin acceder directamente al panel web. El agente puede responder preguntas del tipo «¿qué VPS hay en producción?», «¿cuál es la IP de este cliente?» o «reinicia el VPS 1042 tras un despliegue fallido», siempre dentro de los límites del inventario y las políticas de seguridad.

- **Impacto estratégico:** Virtualizor suele ser el plano de control de hosting compartido o revendedor. Este provider unifica ese inventario junto a Proxmox, Hetzner y SSH en una sola interfaz MCP, lo que permite correlacionar incidentes (DNS en Cloudflare + VPS en Virtualizor + logs vía SSH) desde Cursor u otro cliente MCP.

- **Prerrequisitos:**
  - Entrada en `config/inventory.json` con `provider: "virtualizor"`, URL del panel, `apiKey` y `apiPass` (Admin API).
  - Credenciales con permisos suficientes en Virtualizor para listar servidores (`act=servers`), VPS (`act=vs`) y ejecutar power actions (`start`, `stop`, `restart`).
  - Variables de entorno MCP: `SYSADMIN_CONFIRM_TOKEN` cuando `defaults.requireConfirm` es `true` (valor por defecto en el ejemplo) o cuando `SYSADMIN_PRODUCTION_MODE=true`.
  - Opcional pero recomendado: `readOnly: true` en hosts de solo auditoría; `allowedTools` como lista blanca por host.

> ⚠️ **Importante:** Las credenciales Admin API (`apiKey` / `apiPass`) se envían en cada petición POST a `{url}/index.php`. Protege el inventario y usa referencias `${VIRTUALIZOR_API_KEY}` en lugar de secretos en texto plano.

**Esquema de inventario (campos obligatorios y opcionales):**

| Campo | Obligatorio | Descripción |
|-------|:-----------:|-------------|
| `id` | Sí | Identificador único usado como `hostId` en todas las tools |
| `name` | Sí | Nombre legible para operadores |
| `provider` | Sí | Debe ser `"virtualizor"` |
| `url` | Sí | URL base del panel (ej. `https://panel.example.com:4085`) |
| `apiKey` | Sí | Admin API Key |
| `apiPass` | Sí | Admin API Password |
| `port` | No | Documentado en esquema; la URL ya incluye el puerto habitualmente |
| `readOnly` | No | Si `true`, bloquea tools no clasificadas como lectura (p. ej. `vm-power`) |
| `allowedTools` | No | Lista blanca de nombres de tool permitidos en este host |
| `tags`, `description` | No | Metadatos para filtrado y documentación interna |

---

### 2. Guía Operativa Paso a Paso

#### Paso 1: Registrar el panel en el inventario

Antes de invocar cualquier tool, el host Virtualizor debe existir en `config/inventory.json`. Tome como referencia el host `virt-panel` del archivo `config/inventory.example.json`: URL del panel, credenciales Admin API y, si el entorno es producción de solo lectura, `readOnly: true` para impedir acciones de escritura aunque el token MCP tenga permisos.

Verifique conectividad de red desde el proceso MCP hacia el puerto del panel (típicamente **4085** HTTPS). El cliente construye todas las llamadas contra `{url normalizada}/index.php` con cuerpo `application/x-www-form-urlencoded`.

#### Paso 2: Descubrir infraestructura (lectura)

**Inventario de nodos (servidores físicos/hypervisors):** invoque `list-nodes` con `hostId` apuntando al panel Virtualizor. La tool consulta la Admin API con `act=servers` y devuelve nodos con `nodeId`, nombre, estado, uso de CPU y RAM agregada por servidor.

**Inventario de VPS:** invoque `list-vms` con el mismo `hostId`. Opcionalmente filtre por `status`: `running`, `stopped` o `all`. Si omite `hostId`, el registro agrega VPS de todos los hypervisors del inventario que tengan `list-vms` en `allowedTools` (o sin restricción de lista).

**Detalle de un VPS concreto:** use `get-vm` con `hostId` y `vmId` (campo `vpsid` en Virtualizor). La respuesta incluye resumen normalizado (`VmSummary`) más un objeto `raw` sanitizado (contraseñas y claves API redactadas).

**Estado de un nodo:** `get-node-status` con `hostId` y `nodeId` (ID del servidor en Virtualizor, campo `serid`). Si omite `nodeId`, devuelve la lista completa de nodos del panel.

**Salud agregada:** `health-check` con `hostId` calcula `vpsTotal`, `vpsRunning` y `vpsStopped`; el estado global se marca `healthy` si la API responde (no evalúa umbrales de disco en el panel).

**Red / IPs:** `list-network` devuelve un mapa `{ vmId, name, ip, node }` extraído del listado de VPS, útil para cruzar DNS o firewalls externos.

#### Paso 3: Acciones de energía y confirmación

Para **encender, apagar, reiniciar o apagado ordenado** de un VPS, invoque `vm-power` con:

| Parámetro | Significado |
|-----------|-------------|
| `hostId` | ID del panel en inventario |
| `vmId` | ID numérico del VPS (`vpsid`) |
| `action` | Una de: `start`, `stop`, `shutdown`, `reboot`, `reset` |
| `confirm` | Debe ser `true` cuando la política lo exija |
| `confirmToken` | Debe coincidir con `SYSADMIN_CONFIRM_TOKEN` |

**Reglas de confirmación (código en `src/tools/vms.ts`):**

- Acciones **destructivas** (`stop`, `shutdown`, `reboot`, `reset`) siempre requieren `confirm=true` y `confirmToken` válido si `requireConfirm` está activo.
- Con **`SYSADMIN_PRODUCTION_MODE=true`**, incluso `start` exige confirmación.
- Host con **`readOnly: true`** bloquea `vm-power` independientemente del token.

**Mapeo de acciones MCP → Admin API Virtualizor:**

| Acción MCP | `act` en Virtualizor | Efecto en el VPS |
|------------|----------------------|------------------|
| `start` | `start` | Enciende el VPS |
| `stop` | `stop` | Apagado forzado (hard stop) |
| `shutdown` | `stop` | ⚠️ Mapeado a `stop`, no a apagado ACPI suave |
| `reboot` | `restart` | Reinicio vía panel |
| `reset` | `restart` | ⚠️ Mapeado a `restart`, no a reset de hardware |
| `suspend` / `resume` | — | **No soportado** — error `Unsupported Virtualizor action` |

Tras una acción exitosa, la respuesta incluye `success: true`, `action`, `vmId`, `hostId` y un `message` derivado del campo `done` o `msg` de la API.

---

### 3. Anatomía y Efectos en el Sistema (Deep-Dive)

#### Flujo de una petición MCP → Virtualizor

```
Cliente MCP → guardToolAccess (política + rate limit + auditoría)
           → VirtualizorClient.call(act, extra, post)
           → POST {url}/index.php  (api=json, adminapikey, adminapipass, act=...)
           → Respuesta JSON → normalización VmSummary / NodeSummary
```

Todas las llamadas usan **timeout HTTP** configurado por `getHttpTimeout()`. Los errores de la API (`data.error`) se convierten en `SysadminError` con el texto unido de los mensajes.

#### Tabla de tools, categoría de seguridad y endpoint API

| Tool MCP | Categoría | Confirmación | Mapeo Admin API / comportamiento |
|----------|-----------|:------------:|----------------------------------|
| `list-nodes` | lectura | No | `act=servers` |
| `get-node-status` | lectura | No | Reutiliza `listNodes`; filtra por `nodeId` |
| `list-vms` | lectura | No | `act=vs`, paginación `page=1`, `reslen=100` |
| `get-vm` | lectura | No | `act=vs`, `vpsid={vmId}`, `reslen=1` |
| `vm-power` | destructiva | Sí* | `act=start\|stop\|restart`, body `vpsid` |
| `health-check` | lectura | No | `listVms` + conteo de estados |
| `list-network` | lectura | No | `listVms` → extracción de IPs |
| `list-containers` | — | — | **No aplica** (solo Proxmox LXC) |
| `list-vm-snapshots` | — | — | **No soportado** en Virtualizor |
| `create-vm-snapshot` | — | — | **No soportado** en Virtualizor |

\* Ver reglas de confirmación en la sección 2.

#### Normalización de datos

| Campo Virtualizor | Campo MCP | Notas |
|-------------------|-----------|-------|
| `vpsid` / `vps_id` | `vmId` | Identificador principal |
| `vps_name`, `hostname` | `name` | Fallback a `vpsid` |
| `status` `1`/`on` | `running` | |
| `status` `0`/`off` | `stopped` | |
| `virt` | `type` | `kvm`, `qemu` (Xen), `openvz`, o `unknown` |
| `serid`, `server` | `node` | Nodo donde corre el VPS |
| `cores`, `cpu` | `cpu` | |
| `ram`, `memory` | `memoryMb` | |
| `space`, `disk` | `diskGb` | |
| `ips`, `ip` | `ip` | Primera IP disponible |

#### Tabla de efectos en el sistema

| Dimensión | Impacto / Comportamiento |
| --------- | ------------------------ |
| **Herencia y Alcance** | La configuración del host (`readOnly`, `allowedTools`) aplica a todas las tools que reciban su `hostId`. Los defaults globales del inventario (`readOnly`, `requireConfirm`) complementan `SYSADMIN_READ_ONLY` y `SYSADMIN_REQUIRE_CONFIRM` del entorno. |
| **Visibilidad de Datos** | Los listados aparecen en la respuesta JSON del cliente MCP. El detalle `get-vm` incluye `raw` sanitizado: claves como `pass`, `password`, `rootpass`, `vncpass` y credenciales API se redactan antes de devolver. |
| **Ejecución y Triggers** | `vm-power` ejecuta acciones inmediatas en el hypervisor vía panel; no hay cola asíncrona ni webhook en MCP Sysadmin. `health-check` no altera estado; solo lee. La auditoría interna registra inicio y bloqueos de tools vía `guardToolAccess`. |

#### Limitaciones conocidas

- Paginación fija en listado de VPS: **página 1, 100 resultados** (`reslen=100`). Paneles con más de 100 VPS pueden requerir ampliación futura del cliente.
- `shutdown` y `reset` no tienen equivalente semántico exacto en la Admin API expuesta; ambos se traducen a `stop` o `restart`.
- No hay soporte para crear, eliminar o reprovisionar VPS desde MCP.
- El parámetro `node` en `list-vms` está pensado para Proxmox; **Virtualizor lo ignora** en el registro.

---

### 4. Preguntas Frecuentes y Solución de Problemas

#### Casos de borde

**¿Qué ocurre si cambio `readOnly` de `false` a `true` en caliente?**  
El inventario se recarga según el ciclo de vida del servidor MCP. Tras el cambio, `vm-power` fallará con `Tool 'vm-power' blocked: host '…' is readOnly` aunque el operador disponga de `confirmToken`.

**¿Puedo usar `vm-power` con `suspend`?**  
No. VirtualizorClient lanza `Unsupported Virtualizor action: suspend`. Use las acciones documentadas en la tabla de mapeo.

**¿El host aparece en `list-vms` global sin `hostId`?**  
Solo si el host no tiene `allowedTools` restrictivo o incluye `list-vms`. Un host Virtualizor sin esa tool en la lista blanca queda excluido del agregado.

#### Validaciones y errores comunes

| Mensaje / síntoma | Causa probable | Solución |
|-------------------|----------------|----------|
| `Virtualizor API error (vs): …` | Credenciales inválidas o permisos insuficientes | Verifique `apiKey`/`apiPass` y rol Admin en el panel |
| `Virtualizor VPS not found: {id}` | `vmId` incorrecto o VPS en otro panel | Confirme `vpsid` con `list-vms` en el mismo `hostId` |
| `Virtualizor server/node not found` | `nodeId` no coincide con `serid` | Liste nodos con `list-nodes` y use el `nodeId` exacto |
| `Confirmación requerida para 'vm-power'` | Falta `confirm=true` en acción destructiva o en modo producción | Reintente con confirmación y token |
| `confirmToken` inválido | Token no coincide con env | Exporte `SYSADMIN_CONFIRM_TOKEN` en el entorno del servidor MCP |
| `Tool '…' not in allowedTools` | Lista blanca del host | Añada la tool al array `allowedTools` o elimine la restricción |
| Timeout / `Virtualizor request failed` | Panel inaccesible o firewall | Compruebe URL, puerto 4085 y certificado TLS |

> ⚠️ **Importante:** Si la API devuelve `error` como array o objeto JSON, el mensaje completo se propaga al cliente MCP. Revise el panel Virtualizor (logs Admin API) en paralelo para diagnóstico profundo.

---

### 5. Ejemplos

#### Caso de uso: auditoría matutina de VPS en producción

Un operador de hosting necesita saber cuántos VPS están apagados antes del pico de tráfico. Invoca `health-check` con `hostId: "virt-panel"`. La respuesta muestra `vpsTotal`, `vpsRunning` y `vpsStopped`. Si `vpsStopped` es mayor de lo esperado, ejecuta `list-vms` con `status: "stopped"` para obtener nombres e IDs y escalar al equipo de soporte.

#### Caso de uso: reinicio controlado tras despliegue

Tras actualizar una aplicación en un VPS, el despliegue pide reinicio. El operador obtiene el `vmId` con `get-vm` o `list-vms`, luego invoca `vm-power` con `action: "reboot"`, `confirm: true` y el `confirmToken` corporativo. Virtualizor ejecuta `act=restart`; la respuesta MCP confirma `success: true`.

#### Ejemplo de entrada de inventario

```json
{
  "id": "virt-panel",
  "name": "Virtualizor Panel",
  "provider": "virtualizor",
  "url": "https://panel.example.com:4085",
  "apiKey": "${VIRTUALIZOR_API_KEY}",
  "apiPass": "${VIRTUALIZOR_API_PASS}",
  "readOnly": true,
  "allowedTools": [
    "list-vms",
    "get-vm",
    "list-nodes",
    "get-node-status",
    "health-check",
    "list-network"
  ],
  "tags": ["production", "virtualization"]
}
```

#### Ejemplo de invocación `get-vm` (parámetros)

```json
{
  "hostId": "virt-panel",
  "vmId": "1042"
}
```

#### Ejemplo de invocación `vm-power` con confirmación

```json
{
  "hostId": "virt-panel",
  "vmId": "1042",
  "action": "reboot",
  "confirm": true,
  "confirmToken": "<valor de SYSADMIN_CONFIRM_TOKEN>"
}
```

#### Ejemplo de respuesta parcial `list-network`

```json
{
  "hostId": "virt-panel",
  "provider": "virtualizor",
  "ips": [
    { "vmId": "1042", "name": "cliente-acme", "ip": "203.0.113.50", "node": "12" }
  ]
}
```
