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
