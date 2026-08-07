# Provider SSH — Manual Operativo

Documentación derivada del código en `src/providers/ssh/`, `src/tools/ssh.ts`, `src/tools/diagnostics.ts`, `src/security/policy.ts` y `src/config/schema.ts`.

---

### 1. Resumen Ejecutivo y Propósito

**Objetivo:** El provider SSH permite al servidor MCP Sysadmin operar servidores Linux bare-metal o VPS como si un administrador se conectara por terminal, pero con capas de seguridad integradas: allowlist de comandos, bloqueo de patrones destructivos, verificación de fingerprint del host (anti-MITM), confirmación humana para operaciones de escritura y auditoría de cada invocación. Su impacto estratégico es centralizar la administración de servidores físicos y VPS dentro del mismo inventario que Proxmox, Hetzner o Cloudflare, de modo que un agente de IA (Cursor) pueda diagnosticar incidencias, leer logs y ejecutar comandos acotados sin acceso SSH directo del operador.

**Prerrequisitos:**

| Requisito | Detalle |
|-----------|---------|
| **Inventario** | Entrada `provider: "ssh"` en `config/inventory.json` (ver `SshHostSchema`). |
| **Autenticación** | `privateKeyPath` **o** `password` (este último **prohibido** en modo producción). |
| **Anti-MITM** | `hostKeyFingerprint` obligatorio si `SYSADMIN_PRODUCTION_MODE=true`. Obtener con: `ssh-keyscan -H <host> \| ssh-keygen -lf -` |
| **Token de confirmación** | Variable de entorno `SYSADMIN_CONFIRM_TOKEN` para tools `ssh-exec` y `ssh-read-file`. |
| **Permisos en el host** | Usuario SSH con privilegios suficientes para los comandos permitidos (`systemctl`, `journalctl`, `docker`, etc.). |
| **Variables opcionales** | `SYSADMIN_SSH_TIMEOUT_MS` (default 30000), `SYSADMIN_INVENTORY_PATH`, `SYSADMIN_READ_ONLY`, `SYSADMIN_REQUIRE_CONFIRM`. |

Campos del host SSH en inventario:

| Campo | Obligatorio | Descripción |
|-------|:-----------:|-------------|
| `id`, `name`, `provider` | Sí | Identificador único, nombre legible y `"ssh"`. |
| `host`, `username` | Sí | IP o FQDN y usuario de conexión. |
| `port` | No | Default `22`. |
| `privateKeyPath` | Condicional | Ruta a clave privada (soporta `~`). Requerido en producción. |
| `password` | Condicional | Solo desarrollo; rechazado en producción. |
| `passphrase` | No | Si la clave privada está cifrada. |
| `hostKeyFingerprint` | Condicional | Formato `SHA256:...` o MD5 con dos puntos. Obligatorio en producción. |
| `sshAllowlistMode` | No | `true`/`false`; hereda de `defaults.sshAllowlistMode` o modo producción. |
| `allowedCommandPatterns` | No | Regex adicionales para `ssh-exec` (máx. 200 caracteres, sin patrones abiertos). |
| `readOnly` | No | Si `true`, solo tools categoría `read`. |
| `allowedTools` | No | Lista blanca de nombres de tool permitidos en este host. |
| `tags`, `description` | No | Metadatos para filtrado y documentación. |

> ⚠️ **Importante:** Un host con `readOnly: true` bloquea `ssh-exec` y `ssh-read-file` aunque estén en `allowedTools`, porque esas tools son categoría `write`/`destructive`.

---

### 2. Guía Operativa Paso a Paso

#### Paso 1: Registrar el servidor en el inventario

Defina una entrada SSH con identificador estable (`hostId`) que usarán todas las tools MCP. Configure autenticación por clave y, antes de activar producción, capture el fingerprint del host:

```bash
ssh-keyscan -H 10.0.0.5 | ssh-keygen -lf -
```

Copie el valor `SHA256:...` al campo `hostKeyFingerprint`. Sin este valor, el cliente SSH (`SshClient.buildConnectConfig`) rechazará la conexión en modo producción para prevenir ataques man-in-the-middle.

Si el servidor ejecutará solo diagnósticos automatizados, considere `readOnly: true` (como `vps-web-01` en `config/inventory.example.json`): el agente podrá usar las nueve tools de diagnóstico y `get-node-status`, pero no ejecutará comandos arbitrarios ni leerá archivos sensibles sin confirmación explícita.

#### Paso 2: Configurar políticas de comando y acceso a tools

La seguridad opera en tres capas independientes:

1. **`allowedTools`** — restringe qué tools MCP puede invocar el agente en ese host.
2. **`sshAllowlistMode` + `allowedCommandPatterns`** — restringe qué comandos acepta `ssh-exec`.
3. **`SSH_BLOCKED_PATTERNS`** — bloqueo global independiente del allowlist (siempre activo).

En producción, `sshAllowlistMode` está activo por defecto (`isSshAllowlistEnforced`). Los comandos deben coincidir con `DEFAULT_SSH_ALLOWLIST` **más** los patrones custom del inventario o del host. Ejemplos de prefijos permitidos por defecto: `systemctl status|is-active|...`, `journalctl`, `docker ps|logs|...`, `ls`, `df`, `free`, `curl -sS https://...`, etc.

Para ampliar el allowlist sin desactivarlo, añada regex en `defaults.allowedCommandPatterns` o en el host:

```json
"allowedCommandPatterns": [
  "^systemctl (status|restart) nginx$",
  "^journalctl -u nginx --no-pager -n 100$"
]
```

> ⚠️ **Importante:** Los patrones custom se validan al cargar el inventario: no se permiten `.*`, `.+` ni constructores que abran el allowlist de forma peligrosa.

#### Paso 3: Invocar tools desde el agente MCP

Todas las invocaciones pasan por `guardToolAccess`, que verifica permisos (`assertToolAllowed`), rate limit y auditoría. Las tools se dividen en:

- **Escritura / destructivas** — requieren `confirm: true` y `confirmToken` igual a `SYSADMIN_CONFIRM_TOKEN` (salvo `SYSADMIN_REQUIRE_CONFIRM=false`).
- **Solo lectura** — no requieren confirmación; respetan `readOnly` y `allowedTools`.

**Flujo típico de diagnóstico (sin confirmación):**

1. `health-check` con `hostId` → evalúa disco >90% o memoria >90% como `degraded`.
2. `get-node-status` con `hostId` → hostname, uptime, memoria, disco, CPU y load average vía SSH.
3. `ssh-tail-log` con `unit: "nginx"` o `path: "/var/log/nginx/error.log"` → últimas líneas del log.
4. `list-systemd-units` con `state: "failed"` → unidades caídas.

**Flujo típico de intervención (con confirmación):**

1. Operador humano proporciona `confirmToken` al agente (fuera del contexto del modelo).
2. `ssh-exec` con `command`, opcionalmente `cwd` y `timeoutMs`.
3. Revisar `exitCode`, `stdout` y `stderr` en la respuesta JSON.

Para leer configuración en disco, use `ssh-read-file` (no `ssh-exec` con `cat`): resuelve symlinks con `readlink -f`, aplica política de paths sensibles y limita tamaño con `maxBytes` (default 256 KB, máximo 1 MB).

---

### 3. Anatomía y Efectos en el Sistema (Deep-Dive)

| Dimensión | Impacto / Comportamiento |
|-----------|--------------------------|
| **Herencia y Alcance** | `defaults.readOnly`, `defaults.sshAllowlistMode`, `defaults.allowedCommandPatterns` y `defaults.requireConfirm` aplican a todos los hosts salvo override por host. `SYSADMIN_READ_ONLY=true` bloquea globalmente tools no-`read`. El fingerprint y la clave privada son por host; no se comparten entre entradas del inventario. |
| **Visibilidad de Datos** | Las respuestas MCP incluyen `stdout`/`stderr` completos, paths resueltos (`ssh-read-file`), métricas parseadas (`get-node-status`) y metadatos de auditoría interna. Los archivos sensibles (`.env`, claves `.pem`, `/etc/shadow`) están bloqueados o exigen `confirm=true`. La salida de `get-vm` no aplica aquí; en SSH no hay redacción automática del contenido de archivos leídos. |
| **Ejecución y Triggers** | Cada tool abre una sesión SSH efímera (`withClient` → `client.end()` al terminar). `ssh-exec` ejecuta un único comando en shell remoto; si se indica `cwd`, se antepone `cd '<cwd>' &&`. Timeout: `timeoutMs` del input o `SYSADMIN_SSH_TIMEOUT_MS`. Comandos multilínea están prohibidos. Side effects dependen del comando remoto (p. ej. `systemctl restart` afecta el servicio en el servidor destino, no el proceso MCP). |

#### Tools del provider SSH — referencia completa

##### Tools de ejecución y lectura (requieren confirmación)

| Tool | Categoría | Parámetros | Comportamiento |
|------|-----------|------------|----------------|
| **`ssh-exec`** | destructive | `hostId`*, `command`*, `cwd?`, `timeoutMs?` (max 300000), `confirm?`, `confirmToken?` | Ejecuta comando tras validar allowlist, patrones bloqueados y `cwd`. Retorna `exitCode`, `signal`, `stdout`, `stderr`. |
| **`ssh-read-file`** | write | `hostId`*, `path`*, `maxBytes?` (max 1048576), `confirm?`, `confirmToken?` | Resuelve path, valida política de archivos, lee hasta `maxBytes`. Retorna `path` resuelto, `bytes`, `content`. |

*`cwd` permitido solo en:* `/tmp`, `/var/log`, `/var/www`, `/home/*`, `/opt/*`. Bloqueado en `/etc`, `/root`, `/proc`, `/sys`, `/dev`, `/.ssh`, `/run/secrets`.

##### Tools de diagnóstico (solo lectura)

| Tool | Parámetros | Comportamiento |
|------|------------|----------------|
| **`ssh-tail-log`** | `hostId`*, `unit?`, `path?`, `lines?` (default 100, max 500) | `unit` → `journalctl -u UNIT`; `path` → `tail` bajo `/var/log/`. Mutuamente excluyentes. |
| **`list-firewall-rules`** | `hostId`* | Intenta `ufw`, luego `nft`, luego `iptables`. |
| **`list-systemd-units`** | `hostId`*, `state?` (`failed`\|`running`\|`all`, default `failed`) | Lista unidades; `running`/`all` limitadas a 50/80 líneas. |
| **`cert-status`** | `hostId`*, `domain?` | Certbot y/o `openssl s_client` para fechas SSL. |
| **`dns-lookup`** | `hostId`*, `hostname`* | Resolución DNS desde el servidor (`getent`/`nslookup`/`host`). |
| **`check-endpoint`** | `hostId`*, `target`*, `port?` (default 443), `useHttps?` (default true) | `curl` HTTPS o `nc` TCP desde el servidor remoto. |
| **`list-cron`** | `hostId`* | Crontab del usuario SSH y listado de `/etc/cron.d`. |
| **`list-timers`** | `hostId`* | Primeros 50 systemd timers. |
| **`docker-compose-ps`** | `hostId`*, `projectDir?` | Estado de contenedores; `projectDir` debe ser absoluto bajo `/opt/`, `/var/www/`, `/home/*/` o `/tmp/`. |

##### Tools transversales compatibles con SSH

| Tool | Parámetros relevantes | Comportamiento en SSH |
|------|----------------------|------------------------|
| **`get-node-status`** | `hostId`*, `nodeId?` (ignorado en SSH) | Ejecuta script remoto: hostname, uptime, memoria, disco `/`, cores, load average. |
| **`list-nodes`** | `hostId?` | Con filtro SSH, devuelve el host como nodo único. |
| **`health-check`** | `hostId?` | Marca `degraded` si disco o memoria >90%. |
| **`list-network`** | `hostId`*, `node?` (ignorado) | Ejecuta `ip -br addr` o `ifconfig` en el servidor. |

#### Allowlist por defecto (`DEFAULT_SSH_ALLOWLIST`)

Patrones regex permitidos cuando `sshAllowlistMode` está activo (además de custom):

- `systemctl (status|is-active|is-enabled|is-failed|list-units|show)`
- `journalctl`
- `docker (ps|logs|inspect|stats|info|version|compose ps)`
- `kubectl get`
- `nginx -t`, `apachectl -t`, `php -v`, `node -v`, `npm ls`
- `ls`, `df`, `free`, `uptime`, `hostname`
- `ss`, `netstat`, `ip (addr|route|link)`
- `ping -c N`
- `curl -sS? (http://|https://)`

#### Patrones bloqueados (siempre)

Incluyen: `rm -rf`, `mkfs`, `dd if=`, pipe a shell (`curl|sh`), `chmod 777 /`, `userdel`, `passwd root`, deshabilitar `sshd`, `iptables -F`, `ufw disable`, reverse shells con `nc -e`, `find / -delete`, fork bomb, comandos multilínea con `curl/wget/bash`.

#### Paths de archivo

| Tipo | Ejemplos | Política |
|------|----------|----------|
| **Bloqueados** | `/etc/shadow`, `/etc/gshadow`, `/etc/sudoers*` | Nunca legibles. |
| **Sensibles** | `~/.ssh/id_*`, `*.pem`, `*.key`, `/.env`, `/etc/ssl/private/`, `/proc/*/environ` | Requieren `confirm=true` + token. |
| **Resolución** | Symlinks | `readlink -f`; rechaza paths con `..` tras resolver. |

---

### 4. Preguntas Frecuentes y Solución de Problemas

**¿Por qué falla la conexión en producción con "hostKeyFingerprint required"?**

En `SYSADMIN_PRODUCTION_MODE=true`, cada host SSH debe tener fingerprint configurado. Obtenga el valor con `ssh-keyscan` y actualice el inventario. Sin fingerprint, el servidor MCP no confía en la clave del host remoto.

**¿Por qué "SSH command not in allowlist"?**

El comando no coincide con ningún patrón de `DEFAULT_SSH_ALLOWLIST` ni con `allowedCommandPatterns`. Soluciones: añadir un regex específico al host/inventario, o en desarrollo desactivar allowlist con `sshAllowlistMode: false` (no recomendado en producción).

**¿Por qué "SSH command blocked by security policy"?**

El comando coincide con un patrón de la lista negra global (`SSH_BLOCKED_PATTERNS`), independientemente del allowlist. Reformule la operación o use una tool de diagnóstico read-only equivalente.

**¿Puedo usar `ssh-exec` para leer `/etc/nginx/nginx.conf`?**

Técnicamente un `cat` podría pasar el allowlist si coincide con `ls`, pero la arquitectura espera `ssh-read-file` para archivos. Además, `/etc` no es un `cwd` válido para `ssh-exec`. Use `ssh-read-file` con confirmación si el path es sensible.

**¿Qué ocurre si el comando excede el timeout?**

El stream SSH se cierra y se lanza `SSH command timed out after Nms on <hostId>`. Aumente `timeoutMs` en la invocación (hasta 300000) o `SYSADMIN_SSH_TIMEOUT_MS` en el entorno MCP.

**¿Cómo funciona `readOnly` vs `allowedTools`?**

`readOnly: true` impide cualquier tool que no sea categoría `read` en `TOOL_CATEGORIES`. Si `allowedTools` lista solo `ssh-exec` pero el host es `readOnly`, la tool seguirá bloqueada. Ambos mecanismos deben ser coherentes.

**¿El agente conoce el `confirmToken`?**

No por diseño. El operador humano debe proporcionarlo en el momento de autorizar una operación destructiva o lectura sensible. Si `SYSADMIN_REQUIRE_CONFIRM=false`, las tools destructivas no exigen token (útil solo en desarrollo).

**Casos de borde:**

- **Clave con passphrase incorrecta:** error de conexión SSH en `client.on("error")`.
- **`unit` y `path` en `ssh-tail-log`:** error explícito "Provide unit or path, not both".
- **Path de log fuera de `/var/log/`:** rechazado por `LOG_PATH_PATTERN`.
- **Archivo remoto > `maxBytes`:** se trunca con `head -c`; no hay error, pero el contenido es parcial.
- **Host no encontrado:** `Host not found in inventory: <hostId>`.

**Errores comunes y solución:**

| Mensaje | Causa | Acción |
|---------|-------|--------|
| `Tool 'ssh-exec' blocked: host 'X' is readOnly` | Host en modo lectura | Quitar `readOnly` o usar tools de diagnóstico |
| `Confirmación requerida para 'ssh-exec'` | Falta `confirm: true` | Reintentar con confirmación |
| `cwd '...' is not allowed` | Directorio fuera de allowlist | Usar path permitido o `ssh-read-file` |
| `Multi-line SSH commands are not allowed` | Salto de línea en `command` | Un comando por invocación |
| `Reading '...' blocked: path is never allowed` | Archivo en lista negra | No recuperable; cambiar enfoque |
| `SSH host X requires privateKeyPath or password` | Sin credenciales | Configurar autenticación en inventario |

---

### 5. Ejemplos

#### Caso de uso: VPS web en producción solo lectura

El host `vps-web-01` tiene `readOnly: true`. El agente investiga lentitud sin riesgo de mutación:

```json
{ "hostId": "vps-web-01" }
```

Invocar `health-check` → si `degraded`, seguir con `get-node-status`, `list-systemd-units` (`state: "failed"`) y `ssh-tail-log` (`unit: "nginx"`, `lines: 200`).

#### Caso de uso: Reinicio controlado de Nginx en bare-metal

Inventario con patrón allowlist `^systemctl (status|restart) nginx$`. Operador autoriza con token:

```json
{
  "hostId": "bare-metal-01",
  "command": "systemctl restart nginx",
  "confirm": true,
  "confirmToken": "<SYSADMIN_CONFIRM_TOKEN>"
}
```

Verificar después con `ssh-exec` y `command: "systemctl is-active nginx"` (permitido por allowlist por defecto) o `list-systemd-units` con `state: "running"`.

#### Caso de uso: Leer log de aplicación en `/var/log`

```json
{
  "hostId": "bare-metal-01",
  "unit": "myapp.service",
  "lines": 150
}
```

Tool: `ssh-tail-log`. No requiere confirmación.

#### Caso de uso: Verificar certificado SSL antes de renovación

```json
{
  "hostId": "vps-web-01",
  "domain": "www.example.com"
}
```

Tool: `cert-status`. Combina salida de certbot y handshake OpenSSL.

#### Caso de uso: Comprobar conectividad desde el servidor hacia un API externo

```json
{
  "hostId": "bare-metal-01",
  "target": "api.example.com",
  "port": 443,
  "useHttps": true
}
```

Tool: `check-endpoint`. Útil para distinguir problemas de red local vs. destino remoto.

#### Caso de uso: Estado de stack Docker Compose en `/opt/app`

```json
{
  "hostId": "bare-metal-01",
  "projectDir": "/opt/myapp"
}
```

Tool: `docker-compose-ps`. El directorio debe cumplir la regex de paths permitidos.

#### Ejemplo de entrada de inventario (extracto)

```json
{
  "id": "bare-metal-01",
  "name": "Servidor Físico 1",
  "provider": "ssh",
  "host": "10.0.0.5",
  "port": 22,
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "hostKeyFingerprint": "SHA256:REPLACE_WITH_ssh-keyscan_OUTPUT",
  "sshAllowlistMode": true,
  "allowedCommandPatterns": [
    "^systemctl (status|restart) nginx$",
    "^journalctl -u nginx --no-pager -n 100$"
  ],
  "allowedTools": ["ssh-exec", "ssh-read-file", "get-node-status"],
  "tags": ["physical", "production"]
}
```

Este host permite ejecución acotada a Nginx y lectura de archivos, más consulta de métricas del nodo, pero ninguna otra tool MCP unless se añada a `allowedTools`.
