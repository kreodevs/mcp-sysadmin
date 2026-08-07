# Provider Cloudflare — Manual operativo MCP Sysadmin

Integración con la **API v4 de Cloudflare** (`https://api.cloudflare.com/client/v4`) para gestionar zonas DNS, registros, purga de caché CDN y consulta de rulesets WAF, con confirmación obligatoria en operaciones mutables.

---

### 1. Resumen Ejecutivo y Propósito

- **Objetivo:** Exponer operaciones de DNS, CDN y visibilidad WAF de Cloudflare a clientes MCP, de modo que operadores y agentes puedan auditar zonas, consultar o modificar registros, purgar caché tras despliegues y verificar validez del token API — sin acceder a la dashboard web para cada cambio rutinario.

- **Impacto estratégico:** Cloudflare suele ser el plano de resolución de nombres y borde CDN/WAF. Centralizar estas operaciones en MCP Sysadmin permite runbooks del tipo «despliega app → purga caché → verifica registro A» en un solo hilo de conversación, con barreras de confirmación en cambios destructivos.

- **Prerrequisitos:**
  - Host en inventario con `provider: "cloudflare"` y `apiToken` (token de API con scopes acordes a cada operación).
  - Para tools que requieren zona: `zoneId` en parámetros **o** `defaultZoneId` en el host (recomendado para dominios de producción únicos).
  - `accountId` opcional en esquema (referencia documental; la resolución de zona usa `zoneId`).
  - `SYSADMIN_CONFIRM_TOKEN` para `create-dns-record`, `update-dns-record`, `delete-dns-record` y `purge-cache`.

> ⚠️ **Importante:** Un token con permiso excesivo (Account:Edit global) amplifica el impacto de un error confirmado por el agente. Aplique principio de mínimo privilegio: Zone.DNS Edit solo en zonas necesarias, Cache Purge solo donde corresponda.

**Esquema de inventario:**

| Campo | Obligatorio | Descripción |
|-------|:-----------:|-------------|
| `id` | Sí | `hostId` en tools |
| `name` | Sí | Nombre descriptivo |
| `provider` | Sí | `"cloudflare"` |
| `apiToken` | Sí | Bearer token API |
| `defaultZoneId` | No | Zone ID por defecto cuando la tool omite `zoneId` |
| `accountId` | No | Identificador de cuenta (metadato) |
| `readOnly` | No | Bloquea tools destructivas aunque el token API pueda escribir |
| `allowedTools` | No | Lista blanca |

---

### 2. Guía Operativa Paso a Paso

#### Paso 1: Registrar Cloudflare y resolver la zona de trabajo

Configure el host como `cf-main` en `config/inventory.example.json`: token, `defaultZoneId` del dominio principal y `allowedTools` acotadas a lectura si solo necesita auditoría.

Para descubrir Zone IDs, invoque **`list-zones`** con `hostId`. Opcionalmente filtre por `name` (dominio exacto). Guarde el `id` de la zona en `defaultZoneId` para simplificar invocaciones posteriores.

Verifique conectividad y validez del token con **`health-check`**: llama `GET /user/tokens/verify` y lista zonas; estado `healthy` si `tokenStatus === "active"`.

#### Paso 2: Consultar DNS y borde WAF (lectura)

**Registros DNS:** `list-dns-records` requiere `hostId` y resuelve `zoneId` vía parámetro o `defaultZoneId`. Filtros opcionales: `type` (A, CNAME, TXT, …) y `name`.

**Registro individual:** `get-dns-record` con `recordId` (UUID Cloudflare del registro).

**Rulesets WAF:** `list-waf-rules` → `GET /zones/{zoneId}/rulesets`. Devuelve id, nombre, `kind`, `phase` y versión — útil para inventario de reglas administradas vs custom, sin editar rulesets desde MCP.

**Vista de red unificada:** `list-network` devuelve registros DNS simplificados (`id`, `type`, `name`, `content`, `proxied`) de la zona resuelta; equivalente conceptual a un inventario de publicaciones DNS + estado de proxy naranja.

#### Paso 3: Mutaciones con confirmación explícita

Toda operación que modifica estado en Cloudflare exige **`confirm: true`** y **`confirmToken`** válido (categoría *destructiva* en política de seguridad), además de pasar `guardToolAccess` y respetar `readOnly` del host.

**Crear registro — `create-dns-record`**

Parámetros obligatorios: `type`, `name`, `content`. Opcionales con significado operativo:

| Parámetro | Efecto |
|-----------|--------|
| `ttl` | Segundos (1–86400); `1` = automático en Cloudflare |
| `proxied` | `true` activa proxy CDN (naranja); `false` expone IP origen (gris) |
| `priority` | Relevante en MX/SRV |
| `comment` | Nota visible en dashboard |

API: `POST /zones/{zoneId}/dns_records`.

**Actualizar — `update-dns-record`**

Solo envíe campos a cambiar (`PATCH`). Confirmación obligatoria. API: `PATCH /zones/{zoneId}/dns_records/{recordId}`.

**Eliminar — `delete-dns-record`**

Irreversible en términos de resolución DNS. API: `DELETE /zones/{zoneId}/dns_records/{recordId}`.

**Purgar caché — `purge-cache`**

Por defecto `purgeEverything: true` → body `{ purge_everything: true }`. Para invalidación selectiva, `purgeEverything: false` y array `files` con URLs completas. API: `POST /zones/{zoneId}/purge_cache`.

> ⚠️ **Importante:** Purgar toda la caché incrementa carga en origen y latencia percibida hasta re-calentar CDN. Tras despliegues incrementales, prefiera `files` con URLs concretas.

---

### 3. Anatomía y Efectos en el Sistema (Deep-Dive)

#### Resolución de `zoneId`

`CloudflareClient.resolveZoneId(zoneId?)` usa el parámetro de la tool o cae en `host.defaultZoneId`. Si ambos faltan, lanza:

`zoneId required (pass as parameter or set defaultZoneId on Cloudflare host in inventory).`

En `list-network`, el segundo argumento interno reutiliza ese resolver (el parámetro `node` en el registro se interpreta como `zoneId` opcional).

#### Tabla completa de tools y API

| Tool MCP | Categoría | Confirmación | Endpoint Cloudflare |
|----------|-----------|:------------:|---------------------|
| `list-zones` | lectura | No | `GET /zones` |
| `list-dns-records` | lectura | No | `GET /zones/{zoneId}/dns_records` |
| `get-dns-record` | lectura | No | `GET /zones/{zoneId}/dns_records/{id}` |
| `create-dns-record` | destructiva | **Sí** | `POST /zones/{zoneId}/dns_records` |
| `update-dns-record` | destructiva | **Sí** | `PATCH /zones/{zoneId}/dns_records/{id}` |
| `delete-dns-record` | destructiva | **Sí** | `DELETE /zones/{zoneId}/dns_records/{id}` |
| `purge-cache` | destructiva | **Sí** | `POST /zones/{zoneId}/purge_cache` |
| `list-waf-rules` | lectura | No | `GET /zones/{zoneId}/rulesets` |
| `list-network` | lectura | No | Derivado de DNS records |
| `health-check` | lectura | No | `GET /user/tokens/verify` + `GET /zones` |

Cloudflare **no** expone tools de VMs; `list-vms` y `vm-power` no aplican a este provider.

#### Validaciones de esquema (Zod)

- `ttl`: entero 1–86400.
- `files` en purge: cada entrada debe ser URL válida.
- `create-dns-record`: `type`, `name`, `content` mínimos longitud 1.

Errores API con `success: false` se agregan desde `errors[].message` en `SysadminError`.

#### Tabla de efectos en el sistema

| Dimensión | Impacto / Comportamiento |
| --------- | ------------------------ |
| **Herencia y Alcance** | `defaultZoneId` aplica a todas las tools de zona cuando omiten `zoneId`. Un host `readOnly: true` impide mutaciones aunque el token Cloudflare tenga permisos de escritura. |
| **Visibilidad de Datos** | Cambios DNS propagan según TTL (o instantáneamente en registros proxied para resolución Cloudflare). Purga de caché afecta PoPs globales; no invalida DNS. Rulesets listados no implican cambio de tráfico hasta editarse en dashboard u otra API. |
| **Ejecución y Triggers** | MCP no encola trabajos: cada tool es síncrona contra API v4. Auditoría interna registra intentos bloqueados (token, readOnly, rate limit). No hay integración con Workers, Page Rules legacy ni Transform Rules en el cliente actual. |

#### Limitaciones conocidas

- Sin tools para crear zonas, gestionar certificados SSL, Workers o Zero Trust.
- `list-waf-rules` solo **lista** rulesets; no crea ni modifica reglas WAF.
- `list-dns-records` pagina con `per_page=100`; zonas muy grandes pueden requerir ampliación futura.
- `accountId` en inventario no se usa en llamadas del cliente actual.

---

### 4. Preguntas Frecuentes y Solución de Problemas

#### Casos de borde

**¿Qué ocurre si cambio `defaultZoneId` a otro dominio?**  
Todas las tools sin `zoneId` explícito operarán sobre la nueva zona de inmediato. Revise dos veces antes de confirmar `delete-dns-record` o `purge-cache`.

**¿Puedo tener readOnly en inventario pero token con permiso de escritura?**  
Sí. MCP bloqueará tools destructivas localmente. El token sigue siendo sensible si se filtra fuera de MCP.

**¿Proxied vs DNS only?**  
`proxied: true` oculta el origen tras IPs de Cloudflare y habilita CDN/WAF en el tráfico HTTP(S). `false` expone `content` directamente a resolvers — use para registros no HTTP (mail, validaciones TXT) o subdominios bypass.

#### Errores comunes

| Mensaje | Causa | Solución |
|---------|-------|----------|
| `zoneId required …` | Falta parámetro y `defaultZoneId` | Añada `defaultZoneId` o pase `zoneId` |
| `Cloudflare API error: …` | Scope insuficiente, zona errónea o conflicto de registro | Revise token scopes y dashboard |
| `Host … is not a Cloudflare provider` | `hostId` incorrecto | Use host con `provider: "cloudflare"` |
| `Confirmación requerida para 'create-dns-record'` | Falta confirmación | `confirm: true` + token |
| Token `degraded` en health | Token expirado o revocado | Rote token; revise `tokenExpiresOn` |
| Purge con `files` vacío | `purgeEverything: false` sin URLs | Proporcione URLs completas https:// |

---

### 5. Ejemplos

#### Caso de uso: apuntar staging a nuevo servidor tras migración

Tras mover la app a `203.0.113.10`, el operador ejecuta `update-dns-record` sobre el registro A de `staging.example.com`, cambia `content`, mantiene `proxied: true`, confirma con token, y luego `purge-cache` con `files: ["https://staging.example.com/"]` para evitar purga global.

#### Caso de uso: auditoría de exposición DNS

Invocación de `list-network` con `hostId: "cf-main"` (usa `defaultZoneId`). El operador revisa qué registros tienen `proxied: false` y correlaciona con inventario Hetzner/SSH para detectar orígenes expuestos.

#### Inventario de solo lectura (recomendado para agentes autónomos)

```json
{
  "id": "cf-main",
  "name": "Cloudflare Production",
  "provider": "cloudflare",
  "apiToken": "${CLOUDFLARE_API_TOKEN}",
  "accountId": "${CLOUDFLARE_ACCOUNT_ID}",
  "defaultZoneId": "${CLOUDFLARE_ZONE_ID}",
  "readOnly": true,
  "allowedTools": [
    "list-zones",
    "list-dns-records",
    "get-dns-record",
    "list-waf-rules",
    "health-check",
    "list-network"
  ],
  "tags": ["dns", "cdn", "cloudflare"]
}
```

#### Crear registro TXT de verificación

```json
{
  "hostId": "cf-main",
  "zoneId": "abc123def456",
  "type": "TXT",
  "name": "_verify",
  "content": "verification-token-here",
  "ttl": 3600,
  "proxied": false,
  "confirm": true,
  "confirmToken": "<SYSADMIN_CONFIRM_TOKEN>"
}
```

#### Purga selectiva post-deploy

```json
{
  "hostId": "cf-main",
  "purgeEverything": false,
  "files": [
    "https://example.com/assets/app.js",
    "https://example.com/api/health"
  ],
  "confirm": true,
  "confirmToken": "<SYSADMIN_CONFIRM_TOKEN>"
}
```

#### Respuesta `list-zones` (fragmento)

```json
{
  "hostId": "cf-main",
  "count": 1,
  "zones": [
    {
      "id": "abc123def456",
      "name": "example.com",
      "status": "active",
      "paused": false,
      "type": "full",
      "nameServers": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]
    }
  ]
}
```
