# Stockly — inventario web

Aplicación web progresiva (PWA) en español con el logotipo Stockly proporcionado. Se adapta a Android, iPhone y escritorio. Los productos y movimientos se guardan en Supabase para que la misma cuenta vea el mismo inventario en sus dispositivos.

## Configurar Supabase

1. Crea un proyecto en [Supabase](https://supabase.com/).
2. En **SQL Editor**, ejecuta el contenido completo de [`supabase/schema.sql`](./supabase/schema.sql). Esto crea las tablas, perfiles, políticas de acceso, colaboración de inventarios, ajuste atómico de existencias y recuperación de cuenta.
3. En **Project Settings → API**, copia la URL del proyecto y la clave pública `anon`/publishable.
4. Pega esos dos valores en `config.js`, en `supabaseUrl` y `supabaseAnonKey`.
5. En **Authentication → Settings**, activa **Allow new users to sign up**. En **Authentication → Providers → Email**, habilita Email y desactiva **Confirm email**. El permiso de registro debe estar activo para que Supabase acepte el alta; desactivar la confirmación evita pedir una verificación por correo y permite a Stockly guardar las preguntas de seguridad antes de terminar el alta.
6. En **Authentication → URL Configuration**, agrega la URL de Stockly publicada a **Redirect URLs** y `http://localhost:8000/` para pruebas locales. Estos destinos se usan para la recuperación de contraseña.
7. Para enviar correos de recuperación de forma fiable en producción, configura un proveedor SMTP propio en **Project Settings → Authentication → SMTP Settings**. No pongas credenciales SMTP en `config.js` ni en el navegador.
8. Ajusta `currency` en `config.js` al código ISO 4217 que use tu negocio (por ejemplo `MXN`, `COP` o `EUR`).

La clave pública se puede usar en una aplicación web porque las tablas tienen Row Level Security (RLS). **No** pongas una clave `service_role` ni una clave secreta en `config.js` o en el navegador.

## Ejecutar y publicar

Sirve esta carpeta con cualquier servidor de archivos estáticos o publícala en un hosting estático con HTTPS. Para instalarla desde el navegador del teléfono, abre su URL y usa **Añadir a pantalla de inicio**. El service worker de la PWA requiere `localhost` o HTTPS; abrir `index.html` directamente permite previsualizar la interfaz, pero no instalarla como PWA.

La aplicación necesita conexión a internet para iniciar sesión y sincronizar cambios. Consulta el inventario al iniciar sesión, cada 30 segundos mientras la página está visible y al volver a ella.

## Alcance actual

- Alta, edición y eliminación de productos; búsqueda y filtro por categoría.
- Almacenes por inventario con existencias separadas por ubicación; alta inicial y compras registran el almacén y se pueden transferir artículos entre almacenes. La vista **Almacenes** muestra el stock de cada ubicación, mientras el inventario general y los reportes conservan el stock total por producto.
- Kárdex con entradas, salidas, referencia, contacto y saldo anterior/actual.
- Ingreso de mercancía con proveedor, factura o referencia.
- Notas de entrega con varios productos; el descuento de stock se valida y guarda en una transacción.
- Reportes de existencias, movimientos por fechas y exportación CSV. El inventario actual también se puede imprimir o guardar como PDF desde el diálogo de impresión del navegador.
- **Configuración** en el menú lateral permite editar el nombre y correo del perfil y cambiar la contraseña confirmando la contraseña actual. El cambio de correo puede requerir confirmación mediante los mensajes enviados por Supabase.
- Recuperación de contraseña con dos respuestas de seguridad guardadas como hashes y enlace de restablecimiento enviado al correo registrado.
- Registro sin verificación de correo: después de validar que las contraseñas coinciden, la cuenta se crea al guardar dos preguntas de seguridad.
- Creación y actualización automática del perfil de usuario al iniciar sesión; los datos de cada cuenta quedan asociados a su identificador autenticado.
- Cada usuario tiene su propio inventario: productos, movimientos, notas de entrega e informes quedan aislados por su ID de cuenta mediante políticas Row Level Security (RLS).
- El propietario puede invitar por correo a una cuenta Stockly existente desde **Compartir**. La otra persona verá la invitación al iniciar sesión y deberá aceptarla dentro de Stockly; no se envían correos de invitación. Una vez aceptada, podrá consultar y modificar ese inventario, alternar entre el propio y los compartidos y el propietario puede revocar el acceso.
- Selector entre tema claro y oscuro; la preferencia queda guardada en el dispositivo.

Si el proyecto Supabase ya tenía instalado el esquema, vuelve a ejecutar el archivo completo [`supabase/schema.sql`](./supabase/schema.sql) para actualizar las tablas, políticas RLS y funciones, incluidas las de inventarios compartidos y existencias por almacén. Los productos existentes se asignan al almacén principal y conservan su saldo total. La versión actualizada de Stockly necesita ese esquema aplicado para registrar artículos por almacén. El archivo solicita a PostgREST actualizar su caché de esquema al terminar.

El esquema usa IDs `bigint` para productos, compatibles con la tabla de inventario existente; conserva los IDs actuales y crea las referencias de movimientos con el mismo tipo. Al volver a ejecutarlo, también agrega a la tabla antigua de productos las columnas que falten (`name`, `sku`, `category`, `price`, `cost`, `stock`, `minimum`, `created_at`) sin borrar sus filas. Migra además tablas antiguas de productos, movimientos y notas para agregar `user_id`. Si hay filas sin propietario y existe exactamente una cuenta en Supabase, se asignan a esa cuenta. Si hay varias (o ninguna), la migración se detiene en vez de asignar inventario a una cuenta incorrecta; en ese caso asigna explícitamente el `user_id` correcto a las filas antiguas en SQL Editor y vuelve a ejecutar el archivo. Al recrear las políticas RLS, el acceso de los miembros se verifica mediante una función protegida y las operaciones se limitan al inventario propio o a los inventarios que la cuenta ha aceptado compartir.

### Error `Could not find the function public.ensure_user_profile`

Este error significa que falta aplicar la función de perfil en Supabase, o que PostgREST aún no ha actualizado la caché. En **Supabase → SQL Editor**, ejecuta de nuevo el archivo completo [`supabase/schema.sql`](./supabase/schema.sql), espera a que termine sin errores y vuelve a cargar Stockly. Si prefieres no repetirlo, ejecuta `NOTIFY pgrst, 'reload schema';` en SQL Editor después de confirmar que la función existe. El mensaje de inicio de sesión validado indica que Supabase aceptó las credenciales; vuelve a iniciar sesión, no intentes crear otra cuenta con el mismo correo.

Las preguntas de seguridad se solicitan después de iniciar sesión por primera vez y son una verificación adicional; el restablecimiento definitivo siempre se realiza mediante el enlace enviado al correo. Mantén actualizado el correo de acceso y guarda respuestas que puedas recordar exactamente.

La moneda de los importes está configurada provisionalmente como USD en `config.js`; cámbiala a la moneda del negocio antes del uso real.
