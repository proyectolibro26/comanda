-- ta-ca · base de datos en Supabase (multi-local con cuentas)
-- Pegar entero en Supabase › SQL Editor › Run. Se puede correr más de una vez.

-- Locales: todo el estado de cada local va en "data".
create table if not exists public.taca_locales (
  id          text primary key,
  data        jsonb not null,
  version     integer not null default 1,
  updated_at  timestamptz not null default now()
);
alter table public.taca_locales add column if not exists nombre       text;
alter table public.taca_locales add column if not exists plan         text not null default 'prueba';
alter table public.taca_locales add column if not exists prueba_hasta timestamptz not null default (now() + interval '14 days');
alter table public.taca_locales add column if not exists creado       timestamptz not null default now();

-- Quién puede entrar a cada local (cuentas de Supabase Auth).
create table if not exists public.taca_miembros (
  local_id text not null references public.taca_locales(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  rol      text not null default 'dueno',
  email    text,
  creado   timestamptz not null default now(),
  primary key (local_id, user_id)
);
-- Cuentas de Roman Web que ven el panel de todos los locales.
create table if not exists public.taca_admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.taca_locales add column if not exists pagado_hasta timestamptz;
alter table public.taca_locales add column if not exists nota text;
alter table public.taca_locales add column if not exists abono text;            -- 'local' o 'encendido'
alter table public.taca_locales add column if not exists mp_suscripcion text;   -- id de la suscripción de Mercado Pago
alter table public.taca_locales add column if not exists mp_estado text;        -- pending, authorized, paused, cancelled

-- Pagos del abono que llegan de Mercado Pago (uno por cobro, nunca se cuenta dos veces).
create table if not exists public.taca_pagos (
  id        text primary key,
  local_id  text not null references public.taca_locales(id) on delete cascade,
  abono     text,
  meses     integer not null,
  monto     numeric,
  creado    timestamptz not null default now(),
  detalle   jsonb
);
alter table public.taca_pagos enable row level security;
revoke all on public.taca_pagos from anon, authenticated;

-- Números de WhatsApp conectados (uno por local). Lo usa el servidor para saber a qué local llega cada mensaje.
create table if not exists public.taca_wa (
  phone_number_id text primary key,
  local_id        text not null unique references public.taca_locales(id) on delete cascade,
  numero          text,
  creado          timestamptz not null default now()
);
alter table public.taca_wa add column if not exists activo boolean not null default true;
alter table public.taca_wa enable row level security;
revoke all on public.taca_wa from anon, authenticated;

-- Estado del abono: 'ok', 'gracia' (venció hace menos de 3 días, sigue andando) o 'bloqueado' (solo lectura).
create or replace function public.taca_estado_plan(p_plan text, p_prueba timestamptz, p_pagado timestamptz)
returns text language sql stable set search_path = public as $$
  select case
    when p_plan = 'suspendido' then 'bloqueado'
    when (case when p_plan = 'activo' then p_pagado else p_prueba end) is null then 'ok'
    when (case when p_plan = 'activo' then p_pagado else p_prueba end) > now() then 'ok'
    when (case when p_plan = 'activo' then p_pagado else p_prueba end) + interval '3 days' > now() then 'gracia'
    else 'bloqueado' end;
$$;

-- Nadie lee ni escribe las tablas directo: todo pasa por las funciones de abajo.
alter table public.taca_locales  enable row level security;
alter table public.taca_miembros enable row level security;
alter table public.taca_admins   enable row level security;
revoke all on public.taca_locales, public.taca_miembros, public.taca_admins from anon, authenticated;

-- Versiones viejas (sin cuentas): se reemplazan.
drop function if exists public.taca_guardar(text, jsonb, integer);

create or replace function public.taca_es_miembro(p_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from taca_miembros where local_id = p_id and user_id = auth.uid());
$$;

-- Locales de la cuenta que inició sesión.
create or replace function public.taca_mis_locales()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'nombre', coalesce(l.nombre, l.data->>'negocio'), 'rol', m.rol,
           'plan', l.plan, 'prueba_hasta', l.prueba_hasta, 'pagado_hasta', l.pagado_hasta,
           'estado', taca_estado_plan(l.plan, l.prueba_hasta, l.pagado_hasta)) order by l.creado), '[]'::jsonb)
  from taca_miembros m join taca_locales l on l.id = m.local_id where m.user_id = auth.uid();
$$;

-- Crear un local nuevo: queda la cuenta como dueña y arranca la prueba gratis.
create or replace function public.taca_crear_local(p_nombre text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id text; v_base text; v_email text;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'Iniciá sesión primero'); end if;
  if length(trim(coalesce(p_nombre, ''))) < 2 then return jsonb_build_object('ok', false, 'error', 'Poné el nombre del local'); end if;
  if (select count(*) from taca_miembros where user_id = auth.uid() and rol = 'dueno') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Llegaste al máximo de locales, escribinos');
  end if;
  v_base := trim(both '-' from regexp_replace(lower(translate(p_nombre, 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunaeiouun')), '[^a-z0-9]+', '-', 'g'));
  v_base := left(coalesce(nullif(v_base, ''), 'local'), 20);
  v_id := v_base || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);
  select email into v_email from auth.users where id = auth.uid();
  insert into taca_locales(id, data, nombre) values (v_id, p_data, trim(p_nombre));
  insert into taca_miembros(local_id, user_id, rol, email) values (v_id, auth.uid(), 'dueno', v_email);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Equipos del personal: leer el estado completo del local (solo miembros).
create or replace function public.taca_leer(p_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('data', data, 'version', version, 'plan', plan, 'prueba_hasta', prueba_hasta,
         'pagado_hasta', pagado_hasta, 'estado', taca_estado_plan(plan, prueba_hasta, pagado_hasta),
         'abono', abono, 'mp_estado', mp_estado,
         'whatsapp', (select numero from taca_wa w where w.local_id = taca_locales.id and w.activo))
  from taca_locales where id = p_id and taca_es_miembro(p_id);
$$;

create or replace function public.taca_version(p_id text)
returns integer language sql stable security definer set search_path = public as $$
  select version from taca_locales where id = p_id and taca_es_miembro(p_id);
$$;

-- Guardar con control de versión (solo miembros). Si otro equipo guardó antes, devuelve lo último para fusionar.
create or replace function public.taca_guardar(p_id text, p_data jsonb, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r taca_locales%rowtype;
begin
  if not taca_es_miembro(p_id) then return jsonb_build_object('ok', false, 'error', 'sin acceso'); end if;
  select * into r from taca_locales where id = p_id for update;
  if taca_estado_plan(r.plan, r.prueba_hasta, r.pagado_hasta) = 'bloqueado' then
    return jsonb_build_object('ok', false, 'error', 'bloqueado');
  end if;
  if r.version <> p_version then
    return jsonb_build_object('ok', false, 'data', r.data, 'version', r.version);
  end if;
  update taca_locales set data = p_data, version = r.version + 1, updated_at = now(),
         nombre = coalesce(nullif(p_data->>'negocio', ''), nombre) where id = p_id;
  return jsonb_build_object('ok', true, 'version', r.version + 1);
end $$;

-- Celular del cliente (QR, sin cuenta): solo la carta, el stock y los pedidos de SU mesa.
create or replace function public.taca_carta(p_id text, p_mesa integer)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', version,
    'pausado', taca_estado_plan(plan, prueba_hasta, pagado_hasta) = 'bloqueado',
    'negocio', data->'negocio',
    'mesas',   data->'mesas',
    'platos',  (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(coalesce(data->'platos', '[]'::jsonb)) x
                where coalesce((x->>'activo')::boolean, true)),
    'insumos', (select coalesce(jsonb_agg(jsonb_build_object('id', x->'id', 'stock', x->'stock')), '[]'::jsonb)
                from jsonb_array_elements(coalesce(data->'insumos', '[]'::jsonb)) x),
    'pedidos', (select coalesce(jsonb_agg(x), '[]'::jsonb)
                from jsonb_array_elements(coalesce(data->'pedidos', '[]'::jsonb)) x
                where x->>'origen' = 'mesa' and (x->>'mesa')::int = p_mesa
                  and not coalesce((x->>'cobrado')::boolean, false)
                  and not coalesce((x->>'anulado')::boolean, false)),
    'llamados', (select coalesce(jsonb_agg(x), '[]'::jsonb)
                 from jsonb_array_elements(coalesce(data->'llamados', '[]'::jsonb)) x
                 where (x->>'mesa')::int = p_mesa)
  ) from taca_locales where id = p_id;
$$;

-- Celular del cliente (QR, sin cuenta): pedir, llamar al mozo o pedir la cuenta.
-- El pedido descuenta el stock y toma el número en el servidor, para que nunca se pisen.
create or replace function public.taca_cliente(p_id text, p_tipo text, p_mesa integer,
                                               p_pedido jsonb default null, p_consumo jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d jsonb; v integer; k text; c numeric; idx integer; st numeric; n integer;
  ahora bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  select data, version into d, v from taca_locales where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Local no encontrado'); end if;
  if (select taca_estado_plan(plan, prueba_hasta, pagado_hasta) from taca_locales where id = p_id) = 'bloqueado' then
    return jsonb_build_object('ok', false, 'error', 'Este local no está tomando pedidos por QR en este momento. Pedile al mozo.');
  end if;
  if p_mesa is null or p_mesa < 1 or p_mesa > coalesce((d->>'mesas')::int, 60) then
    return jsonb_build_object('ok', false, 'error', 'Mesa inválida');
  end if;

  if p_tipo = 'pedido' then
    for k, c in select key, value::numeric from jsonb_each_text(coalesce(p_consumo, '{}'::jsonb)) loop
      idx := null;
      select (ord - 1)::int into idx
        from jsonb_array_elements(d->'insumos') with ordinality e(x, ord) where x->>'id' = k;
      if idx is null then return jsonb_build_object('ok', false, 'error', 'Insumo desconocido'); end if;
      st := (d->'insumos'->idx->>'stock')::numeric;
      if c < 0 or st < c - 0.000001 then
        return jsonb_build_object('ok', false, 'error', 'Se acabó ' || (d->'insumos'->idx->>'nombre') || ', avisale al mozo');
      end if;
      d := jsonb_set(d, array['insumos', idx::text, 'stock'], to_jsonb(round(st - c, 3)));
    end loop;
    n := coalesce((d->>'nextNum')::int, 1);
    d := jsonb_set(d, '{nextNum}', to_jsonb(n + 1));
    d := jsonb_set(d, '{pedidos}', coalesce(d->'pedidos', '[]'::jsonb) || jsonb_build_array(
           p_pedido || jsonb_build_object('id', 'q' || md5(random()::text || clock_timestamp()::text),
             'num', n, 'mesa', p_mesa, 'origen', 'mesa', 'por', 'QR', 'ts', ahora, 'estado', 'nuevo',
             'cobrado', false, 'anulado', false, 'pideCuenta', false, 'consumo', coalesce(p_consumo, '{}'::jsonb))));

  elsif p_tipo = 'llamar' then
    if not exists (select 1 from jsonb_array_elements(coalesce(d->'llamados', '[]'::jsonb)) x where (x->>'mesa')::int = p_mesa) then
      d := jsonb_set(d, '{llamados}', coalesce(d->'llamados', '[]'::jsonb) || jsonb_build_array(
             jsonb_build_object('id', 'l' || md5(random()::text), 'mesa', p_mesa, 'ts', ahora)));
    end if;

  elsif p_tipo = 'cuenta' then
    d := jsonb_set(d, '{pedidos}', (
      select coalesce(jsonb_agg(case when x->>'origen' = 'mesa' and (x->>'mesa')::int = p_mesa
                                       and not coalesce((x->>'cobrado')::boolean, false)
                                       and not coalesce((x->>'anulado')::boolean, false)
                                     then jsonb_set(x, '{pideCuenta}', 'true'::jsonb) else x end order by ord), '[]'::jsonb)
        from jsonb_array_elements(coalesce(d->'pedidos', '[]'::jsonb)) with ordinality e(x, ord)));
  else
    return jsonb_build_object('ok', false, 'error', 'Acción desconocida');
  end if;

  update taca_locales set data = d, version = v + 1, updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'num', n);
end $$;

-- Panel de Roman Web: todos los locales (solo cuentas en taca_admins).
alter table public.taca_locales add column if not exists pagado_hasta timestamptz;
alter table public.taca_locales add column if not exists nota text;

create or replace function public.taca_es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from taca_admins where user_id = auth.uid());
$$;

create or replace function public.taca_admin_locales()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when taca_es_admin() then
    (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'nombre', coalesce(l.nombre, l.data->>'negocio'),
       'tipo', l.data->>'tipo', 'plan', l.plan, 'abono', l.abono, 'mp_estado', l.mp_estado,
       'pagos', (select count(*) from taca_pagos p where p.local_id = l.id),
       'whatsapp', (select numero from taca_wa w where w.local_id = l.id and w.activo), 'prueba_hasta', l.prueba_hasta, 'pagado_hasta', l.pagado_hasta, 'nota', l.nota,
       'creado', l.creado, 'actualizado', l.updated_at,
       'pedidos', coalesce(jsonb_array_length(l.data->'pedidos'), 0),
       'equipo', coalesce(jsonb_array_length(l.data->'equipo'), 0),
       'ventas', (select coalesce(sum((c->>'total')::numeric), 0) from jsonb_array_elements(coalesce(l.data->'cobros', '[]'::jsonb)) c
                  where coalesce((c->>'anulado')::boolean, false) = false),
       'duenos', (select coalesce(jsonb_agg(m.email), '[]'::jsonb) from taca_miembros m where m.local_id = l.id and m.rol = 'dueno'))
       order by l.creado desc), '[]'::jsonb) from taca_locales l)
  else null end;
$$;

-- Cambiar el plan de un local: 'activo' suma días pagos, 'prueba' extiende la prueba, 'suspendido' lo frena.
create or replace function public.taca_admin_plan(p_id text, p_plan text, p_dias integer, p_nota text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not taca_es_admin() then return jsonb_build_object('ok', false, 'error', 'Solo Roman Web'); end if;
  if p_plan not in ('prueba', 'activo', 'suspendido') then return jsonb_build_object('ok', false, 'error', 'Plan inválido'); end if;
  update taca_locales set
    plan = p_plan,
    prueba_hasta = case when p_plan = 'prueba' and coalesce(p_dias, 0) > 0
                        then greatest(coalesce(prueba_hasta, now()), now()) + make_interval(days => p_dias) else prueba_hasta end,
    pagado_hasta = case when p_plan = 'activo' and coalesce(p_dias, 0) > 0
                        then greatest(coalesce(pagado_hasta, now()), now()) + make_interval(days => p_dias) else pagado_hasta end,
    nota = coalesce(p_nota, nota)
  where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'No existe ese local'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Limpieza: locales de prueba sin dueño.
delete from public.taca_locales l where l.id like 'prueba-taca-%' and not exists (select 1 from public.taca_miembros m where m.local_id = l.id);

-- Solo el servidor (api/ en Vercel, con la clave secreta) registra pagos de Mercado Pago.
create or replace function public.taca_pago_registrar(p_pago text, p_local text, p_abono text, p_meses integer,
                                                      p_monto numeric, p_suscripcion text, p_detalle jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_meses is null or p_meses < 1 or p_meses > 24 then return jsonb_build_object('ok', false, 'error', 'meses inválido'); end if;
  if not exists (select 1 from taca_locales where id = p_local) then return jsonb_build_object('ok', false, 'error', 'No existe ese local'); end if;
  insert into taca_pagos(id, local_id, abono, meses, monto, detalle) values (p_pago, p_local, p_abono, p_meses, p_monto, p_detalle)
  on conflict (id) do nothing;
  if not found then return jsonb_build_object('ok', true, 'repetido', true); end if;
  update taca_locales set plan = 'activo', abono = coalesce(p_abono, abono),
    mp_suscripcion = coalesce(p_suscripcion, mp_suscripcion), mp_estado = 'authorized',
    pagado_hasta = greatest(coalesce(pagado_hasta, now()), now()) + make_interval(months => p_meses)
  where id = p_local;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.taca_suscripcion_guardar(p_local text, p_suscripcion text, p_estado text, p_abono text)
returns jsonb language sql security definer set search_path = public as $$
  update taca_locales set mp_suscripcion = p_suscripcion, mp_estado = p_estado, abono = coalesce(p_abono, abono)
  where id = p_local and (mp_suscripcion is null or mp_suscripcion = p_suscripcion or p_estado in ('pending', 'authorized'))
  returning jsonb_build_object('ok', true);
$$;

-- Guardado del servidor (bot de WhatsApp): mismo control de versión que taca_guardar, sin sesión de usuario.
create or replace function public.taca_guardar_servidor(p_id text, p_data jsonb, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r taca_locales%rowtype;
begin
  select * into r from taca_locales where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'No existe ese local'); end if;
  if r.version <> p_version then return jsonb_build_object('ok', false, 'conflicto', true, 'version', r.version); end if;
  update taca_locales set data = p_data, version = r.version + 1, updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'version', r.version + 1);
end $$;

-- Panel de Roman Web: conectar o desconectar el número de WhatsApp de un local.
create or replace function public.taca_admin_wa(p_local text, p_phone_id text, p_numero text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not taca_es_admin() then return jsonb_build_object('ok', false, 'error', 'Solo Roman Web'); end if;
  if coalesce(trim(p_phone_id), '') = '' then
    update taca_wa set phone_number_id = 'baja-' || p_local, numero = null, activo = false where local_id = p_local;
    return jsonb_build_object('ok', true, 'desconectado', true);
  end if;
  if not exists (select 1 from taca_locales where id = p_local) then return jsonb_build_object('ok', false, 'error', 'No existe ese local'); end if;
  insert into taca_wa(phone_number_id, local_id, numero) values (trim(p_phone_id), p_local, nullif(trim(p_numero), ''))
  on conflict (local_id) do update set phone_number_id = excluded.phone_number_id, numero = excluded.numero, activo = true;
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'Ese número ya está conectado a otro local');
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.taca_pago_registrar(text, text, text, integer, numeric, text, jsonb),
  public.taca_suscripcion_guardar(text, text, text, text) to service_role;
grant execute on function public.taca_carta(text, integer), public.taca_cliente(text, text, integer, jsonb, jsonb) to anon, authenticated;
grant execute on function public.taca_es_miembro(text), public.taca_mis_locales(), public.taca_crear_local(text, jsonb),
  public.taca_leer(text), public.taca_version(text), public.taca_guardar(text, jsonb, integer), public.taca_admin_locales(),
  public.taca_es_admin(), public.taca_admin_plan(text, text, integer, text), public.taca_admin_wa(text, text, text) to authenticated;
grant execute on function public.taca_guardar_servidor(text, jsonb, integer) to service_role;

-- Permisos para el servidor de ta-ca (api/ en Vercel, con la clave secreta de Supabase).
grant usage on schema public to service_role;
grant select, insert, update on public.taca_locales, public.taca_miembros, public.taca_pagos, public.taca_wa to service_role;
grant select on public.taca_admins to service_role;
grant execute on function public.taca_estado_plan(text, timestamptz, timestamptz) to service_role;

-- Cobro en la mesa con Mercado Pago: la cuenta de MP de cada local (conectada por OAuth) y los cobros iniciados desde el QR.
-- Solo las lee y escribe el servidor (api/ en Vercel). Nadie más tiene acceso.
create table if not exists public.taca_mp_cuentas (
  local_id      text primary key references public.taca_locales(id) on delete cascade,
  mp_user_id    text,
  access_token  text not null,
  refresh_token text,
  expira        timestamptz,
  conectado     timestamptz not null default now(),
  por           uuid
);
alter table public.taca_mp_cuentas enable row level security;
revoke all on public.taca_mp_cuentas from anon, authenticated;

create table if not exists public.taca_mp_mesa (
  id        text primary key,
  local_id  text not null references public.taca_locales(id) on delete cascade,
  mesa      integer not null,
  pedidos   jsonb not null,
  total     numeric not null,
  estado    text not null default 'pendiente',
  pago_id   text,
  creado    timestamptz not null default now()
);
alter table public.taca_mp_mesa enable row level security;
revoke all on public.taca_mp_mesa from anon, authenticated;
grant select, insert, update, delete on public.taca_mp_cuentas, public.taca_mp_mesa to service_role;

-- Historial: al cerrar el día se guarda el detalle completo (ventas, cobros, auditoría, mermas, gastos, turnos).
-- Antes se borraba; ahora el dueño lo puede abrir desde "Días anteriores".
create table if not exists public.taca_historial (
  id        bigserial primary key,
  local_id  text not null references public.taca_locales(id) on delete cascade,
  dia       text not null,
  ts        timestamptz not null default now(),
  data      jsonb not null
);
create index if not exists taca_historial_local on public.taca_historial(local_id, ts desc);
alter table public.taca_historial enable row level security;
revoke all on public.taca_historial from anon, authenticated;
grant select on public.taca_historial to service_role;

create or replace function public.taca_archivar(p_id text, p_dia text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  if not taca_es_miembro(p_id) then return jsonb_build_object('ok', false, 'error', 'sin acceso'); end if;
  insert into taca_historial(local_id, dia, data) values (p_id, coalesce(nullif(p_dia, ''), to_char(now(), 'YYYY-MM-DD')), p_data) returning id into n;
  return jsonb_build_object('ok', true, 'id', n);
end $$;

create or replace function public.taca_historial_dia(p_id text, p_hid bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when taca_es_miembro(p_id) then
    (select jsonb_build_object('dia', dia, 'ts', ts, 'data', data) from taca_historial where id = p_hid and local_id = p_id)
  end;
$$;
grant execute on function public.taca_archivar(text, text, jsonb), public.taca_historial_dia(text, bigint) to authenticated;

-- Respaldo diario de todos los locales (lo hace /api/respaldo todas las madrugadas; se guardan 30 días).
create table if not exists public.taca_respaldos (
  id       bigserial primary key,
  creado   timestamptz not null default now(),
  locales  integer not null,
  data     jsonb not null
);
alter table public.taca_respaldos enable row level security;
revoke all on public.taca_respaldos from anon, authenticated;
grant select, insert, delete on public.taca_respaldos to service_role;
grant usage, select on sequence public.taca_respaldos_id_seq to service_role;
grant select on public.taca_miembros, public.taca_wa, public.taca_pagos to service_role;

-- ============ Permisos de verdad: PIN en el servidor y equipos vinculados ============
-- Los PIN ya no viajan a los equipos: se guardan cifrados acá y se verifican en el servidor.
-- La tablet de la cajera o del mozo ya no entra con el email y la contraseña del dueño: se vincula
-- con un código de un solo uso y cada persona entra con su PIN. Lo que ve y lo que puede cambiar
-- depende de su rol, y eso lo decide el servidor.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.taca_pines (
  local_id   text not null references public.taca_locales(id) on delete cascade,
  persona_id text not null,
  hash       text not null,
  primary key (local_id, persona_id)
);
create table if not exists public.taca_equipos (
  id            bigserial primary key,
  local_id      text not null references public.taca_locales(id) on delete cascade,
  nombre        text not null,
  token_hash    text not null unique,
  creado        timestamptz not null default now(),
  ultimo        timestamptz,
  activo        boolean not null default true,
  persona_id    text,
  rol           text,
  sesion_hasta  timestamptz,
  intentos      integer not null default 0,
  bloqueo_hasta timestamptz
);
create table if not exists public.taca_codigos (
  codigo  text primary key,
  local_id text not null references public.taca_locales(id) on delete cascade,
  nombre  text not null,
  expira  timestamptz not null,
  usado   boolean not null default false
);
alter table public.taca_pines   enable row level security;
alter table public.taca_equipos enable row level security;
alter table public.taca_codigos enable row level security;
revoke all on public.taca_pines, public.taca_equipos, public.taca_codigos from anon, authenticated;

-- Guarda los PIN que vengan en data->equipo (cifrados) y devuelve los datos sin ningún PIN.
create or replace function public.taca_pines_guardar(p_id text, d jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare e jsonb; otro boolean;
begin
  if d->'equipo' is null or jsonb_typeof(d->'equipo') <> 'array' then return d; end if;
  for e in select x from jsonb_array_elements(d->'equipo') x loop
    if (e->>'pin') ~ '^[0-9]{4,6}$' and coalesce(e->>'id', '') <> '' then
      select exists (select 1 from taca_pines p where p.local_id = p_id and p.persona_id <> e->>'id'
                       and p.hash = extensions.crypt(e->>'pin', p.hash)
                       and exists (select 1 from jsonb_array_elements(d->'equipo') y where y->>'id' = p.persona_id)) into otro;
      if not otro then
        insert into taca_pines(local_id, persona_id, hash) values (p_id, e->>'id', extensions.crypt(e->>'pin', extensions.gen_salt('bf', 8)))
        on conflict (local_id, persona_id) do update set hash = excluded.hash;
      end if;
    end if;
  end loop;
  return jsonb_set(d, '{equipo}', (select coalesce(jsonb_agg(x - 'pin' order by o), '[]'::jsonb)
                                     from jsonb_array_elements(d->'equipo') with ordinality t(x, o)));
end $$;

-- Busca a la persona del equipo con ese PIN (solo personas que siguen en el equipo).
create or replace function public.taca_pin_persona(p_id text, p_pin text)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select x from taca_locales l, jsonb_array_elements(coalesce(l.data->'equipo', '[]'::jsonb)) x
   where l.id = p_id and exists (select 1 from taca_pines p where p.local_id = p_id and p.persona_id = x->>'id'
                                   and p.hash = extensions.crypt(p_pin, p.hash))
   limit 1;
$$;

-- Lo que ve cada rol. El dueño ve todo; el resto no ve el historial de cierres ni la auditoría.
create or replace function public.taca_filtrar(d jsonb, p_rol text)
returns jsonb language sql immutable as $$
  select case when p_rol = 'dueno' then d else (d - 'cierres') || jsonb_build_object('audit', '[]'::jsonb, 'cierres', '[]'::jsonb) end;
$$;

-- Lo que puede cambiar cada rol. Si no es dueño: no toca la configuración ni el equipo, la auditoría
-- solo suma (no se borra ni se edita) y ningún cobro desaparece.
create or replace function public.taca_fusionar_rol(o jsonb, n jsonb, p_rol text)
returns jsonb language plpgsql immutable as $$
declare k text; r jsonb := n;
begin
  if p_rol = 'dueno' then return n; end if;
  foreach k in array array['equipo','cierres','descMax','alias','negocio','mesas','baseUrl','tipo','setup','envio'] loop
    if o ? k then r := jsonb_set(r, array[k], o->k); else r := r - k; end if;
  end loop;
  r := jsonb_set(r, '{audit}', coalesce(o->'audit', '[]'::jsonb) || coalesce((
         select jsonb_agg(x) from jsonb_array_elements(coalesce(n->'audit', '[]'::jsonb)) x
          where not exists (select 1 from jsonb_array_elements(coalesce(o->'audit', '[]'::jsonb)) y where y->>'id' = x->>'id')), '[]'::jsonb));
  r := jsonb_set(r, '{cobros}', coalesce(n->'cobros', '[]'::jsonb) || coalesce((
         select jsonb_agg(y) from jsonb_array_elements(coalesce(o->'cobros', '[]'::jsonb)) y
          where not exists (select 1 from jsonb_array_elements(coalesce(n->'cobros', '[]'::jsonb)) x where x->>'id' = y->>'id')), '[]'::jsonb));
  return r;
end $$;

-- El dueño (con su cuenta) también guarda los PIN cifrados.
create or replace function public.taca_guardar(p_id text, p_data jsonb, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r taca_locales%rowtype; d jsonb;
begin
  if not taca_es_miembro(p_id) then return jsonb_build_object('ok', false, 'error', 'sin acceso'); end if;
  select * into r from taca_locales where id = p_id for update;
  if taca_estado_plan(r.plan, r.prueba_hasta, r.pagado_hasta) = 'bloqueado' then
    return jsonb_build_object('ok', false, 'error', 'bloqueado');
  end if;
  if r.version <> p_version then
    return jsonb_build_object('ok', false, 'data', r.data, 'version', r.version);
  end if;
  d := taca_pines_guardar(p_id, p_data);
  update taca_locales set data = d, version = r.version + 1, updated_at = now(),
         nombre = coalesce(nullif(d->>'negocio', ''), nombre) where id = p_id;
  return jsonb_build_object('ok', true, 'version', r.version + 1);
end $$;

-- PIN en un equipo con la cuenta del dueño.
create or replace function public.taca_pin_verificar(p_id text, p_pin text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when taca_es_miembro(p_id) then taca_pin_persona(p_id, p_pin) end;
$$;
create or replace function public.taca_pin_libre(p_id text, p_pin text, p_salvo text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select taca_es_miembro(p_id) and not exists (
    select 1 from taca_pines p, taca_locales l, jsonb_array_elements(coalesce(l.data->'equipo', '[]'::jsonb)) x
     where l.id = p_id and p.local_id = p_id and x->>'id' = p.persona_id and p.persona_id <> coalesce(p_salvo, '')
       and p.hash = extensions.crypt(p_pin, p.hash));
$$;

-- Vincular un equipo: el dueño pide un código, el equipo lo canjea por una llave propia.
create or replace function public.taca_eq_codigo(p_id text, p_nombre text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare c text; abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int;
begin
  if not taca_es_miembro(p_id) then return jsonb_build_object('ok', false, 'error', 'sin acceso'); end if;
  c := '';
  for i in 1..8 loop c := c || substr(abc, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1); end loop;
  insert into taca_codigos(codigo, local_id, nombre, expira) values (c, p_id, left(coalesce(nullif(trim(p_nombre), ''), 'Equipo'), 40), now() + interval '15 minutes');
  return jsonb_build_object('ok', true, 'codigo', substr(c, 1, 4) || '-' || substr(c, 5, 4));
end $$;

create or replace function public.taca_eq_vincular(p_codigo text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare c taca_codigos%rowtype; t text; code text := upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  select * into c from taca_codigos where codigo = code for update;
  if not found or c.usado or c.expira < now() then
    perform pg_sleep(0.5);
    return jsonb_build_object('ok', false, 'error', 'El código no es válido o ya venció. Pedile uno nuevo al dueño.');
  end if;
  update taca_codigos set usado = true where codigo = code;
  t := encode(extensions.gen_random_bytes(32), 'hex');
  insert into taca_equipos(local_id, nombre, token_hash) values (c.local_id, c.nombre, encode(extensions.digest(t, 'sha256'), 'hex'));
  return jsonb_build_object('ok', true, 'token', t, 'local', c.local_id, 'nombre', c.nombre,
                            'negocio', (select coalesce(data->>'negocio', nombre) from taca_locales where id = c.local_id));
end $$;

create or replace function public.taca_eq_de(p_token text)
returns taca_equipos language sql stable security definer set search_path = public, extensions as $$
  select * from taca_equipos where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and activo;
$$;

create or replace function public.taca_eq_pin(p_token text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e taca_equipos%rowtype; p jsonb;
begin
  e := taca_eq_de(p_token);
  if e.id is null then return jsonb_build_object('ok', false, 'error', 'desvinculado'); end if;
  if e.bloqueo_hasta is not null and e.bloqueo_hasta > now() then
    return jsonb_build_object('ok', false, 'error', 'Demasiados intentos. Esperá unos minutos.');
  end if;
  p := taca_pin_persona(e.local_id, p_pin);
  if p is null then
    update taca_equipos set intentos = case when intentos + 1 >= 8 then 0 else intentos + 1 end,
           bloqueo_hasta = case when intentos + 1 >= 8 then now() + interval '10 minutes' else bloqueo_hasta end
     where id = e.id;
    return jsonb_build_object('ok', false, 'error', 'PIN incorrecto');
  end if;
  update taca_equipos set persona_id = p->>'id', rol = p->>'rol', sesion_hasta = now() + interval '16 hours',
         intentos = 0, bloqueo_hasta = null, ultimo = now() where id = e.id;
  return jsonb_build_object('ok', true, 'persona', p);
end $$;

create or replace function public.taca_eq_salir(p_token text)
returns void language sql security definer set search_path = public as $$
  update taca_equipos set persona_id = null, rol = null, sesion_hasta = null where id = (taca_eq_de(p_token)).id;
$$;

-- Sesión vigente del equipo: rol de la persona que entró con su PIN (y que sigue en el equipo con ese rol).
create or replace function public.taca_eq_rol(e taca_equipos)
returns text language sql stable security definer set search_path = public as $$
  select case when e.id is not null and e.sesion_hasta > now() then
    (select x->>'rol' from taca_locales l, jsonb_array_elements(coalesce(l.data->'equipo', '[]'::jsonb)) x
      where l.id = e.local_id and x->>'id' = e.persona_id limit 1) end;
$$;

create or replace function public.taca_eq_leer(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e taca_equipos%rowtype; r taca_locales%rowtype; ro text;
begin
  e := taca_eq_de(p_token);
  if e.id is null then return jsonb_build_object('desvinculado', true); end if;
  select * into r from taca_locales where id = e.local_id;
  update taca_equipos set ultimo = now() where id = e.id;
  ro := taca_eq_rol(e);
  return jsonb_build_object(
    'data', case when ro is null then jsonb_build_object('negocio', r.data->'negocio', 'setup', true,
                   'equipo', (select coalesce(jsonb_agg(jsonb_build_object('id', x->>'id', 'nombre', x->>'nombre', 'rol', x->>'rol')), '[]'::jsonb)
                                from jsonb_array_elements(coalesce(r.data->'equipo', '[]'::jsonb)) x))
                 else taca_filtrar(r.data, ro) end,
    'version', case when ro is null then -1 else r.version end, 'sinPin', ro is null, 'rol', ro, 'persona', e.persona_id,
    'plan', r.plan, 'prueba_hasta', r.prueba_hasta, 'pagado_hasta', r.pagado_hasta,
    'estado', taca_estado_plan(r.plan, r.prueba_hasta, r.pagado_hasta), 'abono', r.abono, 'mp_estado', r.mp_estado,
    'whatsapp', (select numero from taca_wa w where w.local_id = r.id and w.activo));
end $$;

create or replace function public.taca_eq_version(p_token text)
returns integer language plpgsql stable security definer set search_path = public as $$
declare e taca_equipos%rowtype;
begin
  e := taca_eq_de(p_token);
  if e.id is null then return -2; end if;
  if taca_eq_rol(e) is null then return -1; end if;
  return (select version from taca_locales where id = e.local_id);
end $$;

create or replace function public.taca_eq_guardar(p_token text, p_data jsonb, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e taca_equipos%rowtype; r taca_locales%rowtype; ro text; d jsonb;
begin
  e := taca_eq_de(p_token);
  if e.id is null then return jsonb_build_object('ok', false, 'error', 'desvinculado'); end if;
  ro := taca_eq_rol(e);
  if ro is null then return jsonb_build_object('ok', false, 'error', 'pin'); end if;
  select * into r from taca_locales where id = e.local_id for update;
  if taca_estado_plan(r.plan, r.prueba_hasta, r.pagado_hasta) = 'bloqueado' then
    return jsonb_build_object('ok', false, 'error', 'bloqueado');
  end if;
  if r.version <> p_version then
    return jsonb_build_object('ok', false, 'data', taca_filtrar(r.data, ro), 'version', r.version);
  end if;
  d := taca_fusionar_rol(r.data, p_data, ro);
  if ro = 'dueno' then d := taca_pines_guardar(r.id, d); else d := jsonb_set(d, '{equipo}', coalesce(r.data->'equipo', '[]'::jsonb)); end if;
  update taca_locales set data = d, version = r.version + 1, updated_at = now() where id = r.id;
  update taca_equipos set ultimo = now() where id = e.id;
  return jsonb_build_object('ok', true, 'version', r.version + 1);
end $$;

-- Equipos vinculados de un local (para el dueño) y desconectar uno.
create or replace function public.taca_eq_lista(p_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when taca_es_miembro(p_id) then (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'creado', creado, 'ultimo', ultimo,
           'persona', (select x->>'nombre' from taca_locales l, jsonb_array_elements(coalesce(l.data->'equipo', '[]'::jsonb)) x where l.id = p_id and x->>'id' = e.persona_id and e.sesion_hasta > now() limit 1))
           order by creado), '[]'::jsonb) from taca_equipos e where local_id = p_id and activo) end;
$$;
create or replace function public.taca_eq_quitar(p_id text, p_eid bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not taca_es_miembro(p_id) then return jsonb_build_object('ok', false, 'error', 'sin acceso'); end if;
  update taca_equipos set activo = false, persona_id = null, sesion_hasta = null where id = p_eid and local_id = p_id;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.taca_pines_guardar(text, jsonb), public.taca_pin_persona(text, text), public.taca_eq_de(text), public.taca_eq_rol(taca_equipos) from public, anon, authenticated;
grant execute on function public.taca_pin_verificar(text, text), public.taca_pin_libre(text, text, text), public.taca_eq_codigo(text, text),
  public.taca_eq_lista(text), public.taca_eq_quitar(text, bigint) to authenticated;
grant execute on function public.taca_eq_vincular(text), public.taca_eq_pin(text, text), public.taca_eq_salir(text),
  public.taca_eq_leer(text), public.taca_eq_version(text), public.taca_eq_guardar(text, jsonb, integer) to anon, authenticated;

-- Una sola vez: los PIN que estaban a la vista dentro de los datos pasan a guardarse cifrados.
update public.taca_locales set data = public.taca_pines_guardar(id, data), version = version + 1
 where exists (select 1 from jsonb_array_elements(coalesce(data->'equipo', '[]'::jsonb)) x where x ? 'pin');
