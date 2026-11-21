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
    'qrmesa',  coalesce((data->'mpqr'->>'mesas')::boolean, false),
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

-- Reportes por período (semana, mes, lo que elija el dueño): lo justo de cada día cerrado para armar los números.
create or replace function public.taca_reporte(p_id text, p_desde timestamptz, p_hasta timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when taca_es_miembro(p_id) then (
    select coalesce(jsonb_agg(jsonb_build_object(
      'dia', h.dia, 'ts', h.ts, 'merma', coalesce(h.data->'merma', '0'::jsonb),
      'egresos', (select coalesce(sum((e->>'monto')::numeric), 0) from jsonb_array_elements(coalesce(h.data->'egresos', '[]'::jsonb)) e),
      'cobros', (select coalesce(jsonb_agg(jsonb_build_object('ts', c->'ts', 'total', c->'total', 'pagos', c->'pagos', 'por', c->'por', 'grupo', c->'grupo',
                   'anulado', c->'anulado', 'descuento', c->'descuento', 'propina', c->'propina')), '[]'::jsonb)
                 from jsonb_array_elements(coalesce(h.data->'cobros', '[]'::jsonb)) c),
      'pedidos', (select coalesce(jsonb_agg(jsonb_build_object('origen', p->'origen', 'por', p->'por', 'anulado', p->'anulado', 'total', p->'total', 'ts', p->'ts',
                   'items', (select coalesce(jsonb_agg(jsonb_build_object('nombre', i->'nombre', 'cant', i->'cant', 'precio', i->'precio')), '[]'::jsonb)
                               from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) i))), '[]'::jsonb)
                  from jsonb_array_elements(coalesce(h.data->'pedidos', '[]'::jsonb)) p)
    ) order by h.ts), '[]'::jsonb)
    from taca_historial h where h.local_id = p_id and h.ts >= p_desde and h.ts < p_hasta) end;
$$;
grant execute on function public.taca_reporte(text, timestamptz, timestamptz) to authenticated;

-- ============ Factura electrónica ARCA ============
-- Certificado de Roman Web (uno para homologación y otro para producción). La llave privada la genera el servidor
-- y queda acá: ninguna función pública la devuelve.
create table if not exists public.taca_arca_config (
  env        text primary key check (env in ('homo', 'prod')),
  cuit       text not null,
  key_pem    text,
  csr_pem    text,
  cert_pem   text,
  activo     boolean not null default false,
  actualizado timestamptz not null default now()
);
create table if not exists public.taca_arca_ta (
  env     text primary key,
  token   text not null,
  sign    text not null,
  expira  timestamptz not null
);
create table if not exists public.taca_facturas (
  id        bigserial primary key,
  local_id  text not null references public.taca_locales(id) on delete cascade,
  cobro_id  text,
  env       text not null,
  tipo      integer not null,
  pto       integer not null,
  nro       bigint not null,
  cae       text not null,
  total     numeric not null,
  data      jsonb not null,
  creado    timestamptz not null default now(),
  unique (local_id, env, tipo, pto, nro)
);
create index if not exists taca_facturas_cobro on public.taca_facturas(local_id, cobro_id);
alter table public.taca_arca_config enable row level security;
alter table public.taca_arca_ta     enable row level security;
alter table public.taca_facturas    enable row level security;
revoke all on public.taca_arca_config, public.taca_arca_ta, public.taca_facturas from anon, authenticated;
grant select, insert, update on public.taca_arca_config, public.taca_arca_ta, public.taca_facturas to service_role;
grant usage, select on sequence public.taca_facturas_id_seq to service_role;

-- Para el servidor: de qué local es un equipo vinculado y quién está adentro.
create or replace function public.taca_eq_info(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('local', e.local_id, 'rol', taca_eq_rol(e), 'persona', e.persona_id)
    from taca_equipos e where e.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and e.activo;
$$;
revoke execute on function public.taca_eq_info(text) from public, anon, authenticated;
grant execute on function public.taca_eq_info(text), public.taca_guardar_servidor(text, jsonb, integer) to service_role;

-- Errores de la app y del servidor (los ve Roman Web en el panel y le llegan por Telegram).
create table if not exists public.taca_errores (
  id      bigserial primary key,
  clave   text not null,
  ts      timestamptz not null default now(),
  ultimo  timestamptz not null default now(),
  veces   integer not null default 1,
  origen  text not null,
  local_id text,
  mensaje text not null,
  detalle jsonb
);
create index if not exists taca_errores_clave on public.taca_errores(clave, ultimo desc);
alter table public.taca_errores enable row level security;
revoke all on public.taca_errores from anon, authenticated;
grant select, insert, update on public.taca_errores to service_role;
grant usage, select on sequence public.taca_errores_id_seq to service_role;

-- Ajustes de Roman Web que guarda el servidor (por ejemplo, el chat de Telegram para los avisos).
create table if not exists public.taca_ajustes (
  clave  text primary key,
  valor  jsonb not null,
  actualizado timestamptz not null default now()
);
alter table public.taca_ajustes enable row level security;
revoke all on public.taca_ajustes from anon, authenticated;
grant select, insert, update on public.taca_ajustes to service_role;


-- Avisos con la app cerrada (notificaciones push). Solo los maneja el servidor (service_role).
create table if not exists public.taca_push (
  endpoint  text primary key,
  local_id  text not null references public.taca_locales(id) on delete cascade,
  p256dh    text not null,
  auth      text not null,
  user_id   uuid,
  equipo_id bigint,
  creado    timestamptz not null default now()
);
create index if not exists taca_push_local on public.taca_push(local_id);
alter table public.taca_push enable row level security;
revoke all on public.taca_push from anon, authenticated;
grant select, insert, update, delete on public.taca_push to service_role;

create table if not exists public.taca_push_avisos (
  local_id text not null,
  clave    text not null,
  ts       timestamptz not null default now(),
  primary key (local_id, clave)
);
alter table public.taca_push_avisos enable row level security;
revoke all on public.taca_push_avisos from anon, authenticated;
grant select, insert, update, delete on public.taca_push_avisos to service_role;

-- Cobro en caja con QR de Mercado Pago: sucursal y caja creadas en la cuenta MP de cada local.
alter table public.taca_mp_cuentas add column if not exists qr_store_id text;
alter table public.taca_mp_cuentas add column if not exists qr_pos_id   text;
alter table public.taca_mp_cuentas add column if not exists qr_pos_ext  text;
alter table public.taca_mp_cuentas add column if not exists qr_estatico text;

-- QR de pago en cada mesa (una "caja" de Mercado Pago por mesa) y cobros de mesa hechos con ese QR.
alter table public.taca_mp_cuentas add column if not exists qr_mesas jsonb;
alter table public.taca_mp_mesa    add column if not exists orden text;

-- Fotos de los platos: carpeta pública (las ve el cliente en la carta). Solo un miembro del local sube o borra en la carpeta de su local.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('taca-fotos', 'taca-fotos', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg','image/png','image/webp'];
drop policy if exists "taca fotos subir" on storage.objects;
create policy "taca fotos subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'taca-fotos' and public.taca_es_miembro((storage.foldername(name))[1]));
drop policy if exists "taca fotos borrar" on storage.objects;
create policy "taca fotos borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'taca-fotos' and public.taca_es_miembro((storage.foldername(name))[1]));
-- ===================== App del equipo de ventas (ta-ca.com.ar/equipo) =====================
-- Cada persona entra con su mail y su contraseña (Supabase Auth). Solo ve datos quien está en taca_vt_equipo.
create table if not exists public.taca_vt_equipo (
  id      text primary key,
  nombre  text not null,
  email   text unique,
  rol     text not null default 'vendedor',   -- 'socio' o 'vendedor'
  admin   boolean not null default false,
  parte   numeric not null default 0,         -- % de la ganancia que le toca (socios)
  activo  boolean not null default true,
  creado  timestamptz not null default now()
);
create table if not exists public.taca_vt_config (id integer primary key default 1, data jsonb not null default '{}'::jsonb);
create table if not exists public.taca_vt_contactos (
  id text primary key, nro integer, nombre text not null, tipo text, zona text, direccion text,
  telefono text, whatsapp text, maps text, instagram text, prioridad text, vendedor text,
  estado text not null default 'Sin contactar', proximo text, fecha date, notas text,
  actualizado timestamptz not null default now(), actualizado_por text
);
create table if not exists public.taca_vt_actividad (
  id bigserial primary key, ts timestamptz not null default now(), miembro text not null,
  contacto_id text, tipo text not null, plan text, monto numeric, detalle text
);
create table if not exists public.taca_vt_tareas (
  id text primary key, mes text not null, titulo text not null, asignado text,
  hecho boolean not null default false, vence date, creado_por text, creado timestamptz not null default now()
);
create table if not exists public.taca_vt_objetivos (
  mes text not null, miembro text not null,   -- miembro = id del integrante o 'grupo'
  contactos integer not null default 0, demos integer not null default 0,
  pruebas integer not null default 0, ventas integer not null default 0,
  primary key (mes, miembro)
);
alter table public.taca_vt_equipo enable row level security;
alter table public.taca_vt_config enable row level security;
alter table public.taca_vt_contactos enable row level security;
alter table public.taca_vt_actividad enable row level security;
alter table public.taca_vt_tareas enable row level security;
alter table public.taca_vt_objetivos enable row level security;

create or replace function public.taca_vt_yo_id() returns text
language sql stable security definer set search_path = public as $$
  select id from taca_vt_equipo where activo and email is not null and lower(email) = lower(coalesce(auth.jwt()->>'email','')) limit 1;
$$;
create or replace function public.taca_vt_soy_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select admin from taca_vt_equipo where id = taca_vt_yo_id()), false);
$$;
create or replace function public.taca_vt_soy_socio() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select rol = 'socio' from taca_vt_equipo where id = taca_vt_yo_id()), false);
$$;

drop policy if exists vt_equipo_ver on public.taca_vt_equipo;
create policy vt_equipo_ver on public.taca_vt_equipo for select to authenticated using (taca_vt_yo_id() is not null);
drop policy if exists vt_equipo_admin on public.taca_vt_equipo;
create policy vt_equipo_admin on public.taca_vt_equipo for all to authenticated using (taca_vt_soy_admin()) with check (taca_vt_soy_admin());
drop policy if exists vt_config_ver on public.taca_vt_config;
create policy vt_config_ver on public.taca_vt_config for select to authenticated using (taca_vt_yo_id() is not null);
drop policy if exists vt_config_admin on public.taca_vt_config;
create policy vt_config_admin on public.taca_vt_config for all to authenticated using (taca_vt_soy_admin()) with check (taca_vt_soy_admin());
drop policy if exists vt_contactos_rw on public.taca_vt_contactos;
create policy vt_contactos_rw on public.taca_vt_contactos for select to authenticated using (taca_vt_yo_id() is not null);
drop policy if exists vt_contactos_ins on public.taca_vt_contactos;
create policy vt_contactos_ins on public.taca_vt_contactos for insert to authenticated with check (taca_vt_yo_id() is not null);
drop policy if exists vt_contactos_upd on public.taca_vt_contactos;
create policy vt_contactos_upd on public.taca_vt_contactos for update to authenticated using (taca_vt_yo_id() is not null) with check (taca_vt_yo_id() is not null);
drop policy if exists vt_contactos_del on public.taca_vt_contactos;
create policy vt_contactos_del on public.taca_vt_contactos for delete to authenticated using (taca_vt_soy_admin());
drop policy if exists vt_act_ver on public.taca_vt_actividad;
create policy vt_act_ver on public.taca_vt_actividad for select to authenticated using (taca_vt_yo_id() is not null);
drop policy if exists vt_act_ins on public.taca_vt_actividad;
create policy vt_act_ins on public.taca_vt_actividad for insert to authenticated with check (miembro = taca_vt_yo_id());
drop policy if exists vt_act_del on public.taca_vt_actividad;
create policy vt_act_del on public.taca_vt_actividad for delete to authenticated using (miembro = taca_vt_yo_id() or taca_vt_soy_admin());
drop policy if exists vt_tareas_ver on public.taca_vt_tareas;
create policy vt_tareas_ver on public.taca_vt_tareas for select to authenticated using (taca_vt_yo_id() is not null);
drop policy if exists vt_tareas_ins on public.taca_vt_tareas;
create policy vt_tareas_ins on public.taca_vt_tareas for insert to authenticated with check (taca_vt_yo_id() is not null);
drop policy if exists vt_tareas_upd on public.taca_vt_tareas;
create policy vt_tareas_upd on public.taca_vt_tareas for update to authenticated using (taca_vt_yo_id() is not null) with check (taca_vt_yo_id() is not null);
drop policy if exists vt_tareas_del on public.taca_vt_tareas;
create policy vt_tareas_del on public.taca_vt_tareas for delete to authenticated using (taca_vt_soy_socio() or creado_por = taca_vt_yo_id());
drop policy if exists vt_obj_ver on public.taca_vt_objetivos;
create policy vt_obj_ver on public.taca_vt_objetivos for select to authenticated using (taca_vt_yo_id() is not null);
drop policy if exists vt_obj_socio on public.taca_vt_objetivos;
create policy vt_obj_socio on public.taca_vt_objetivos for all to authenticated using (taca_vt_soy_socio()) with check (taca_vt_soy_socio());

-- Números reales del negocio para el equipo: locales pagando, abono mensual y lo cobrado en el mes.
create or replace function public.taca_vt_metricas(p_mes text default to_char(now() at time zone 'America/Argentina/Buenos_Aires','YYYY-MM'))
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb; ini timestamptz; fin timestamptz; cfg jsonb;
begin
  if taca_vt_yo_id() is null then return null; end if;
  ini := (p_mes || '-01')::timestamp at time zone 'America/Argentina/Buenos_Aires';
  fin := ini + interval '1 month';
  select data into cfg from taca_vt_config where id = 1;
  select jsonb_build_object(
    'pagando',   count(*) filter (where plan = 'activo' and taca_estado_plan(plan, prueba_hasta, pagado_hasta) <> 'bloqueado'),
    'pag_local', count(*) filter (where plan = 'activo' and coalesce(abono,'local') = 'local' and taca_estado_plan(plan, prueba_hasta, pagado_hasta) <> 'bloqueado'),
    'pag_encendido', count(*) filter (where plan = 'activo' and abono = 'encendido' and taca_estado_plan(plan, prueba_hasta, pagado_hasta) <> 'bloqueado'),
    'en_prueba', count(*) filter (where plan = 'prueba' and prueba_hasta > now()),
    'nuevos_mes', count(*) filter (where creado >= ini and creado < fin),
    'total', count(*)
  ) into r from taca_locales where id not in (select m.local_id from taca_miembros m join taca_admins a on a.user_id = m.user_id);
  r := r || jsonb_build_object(
    'cobrado_mes', coalesce((select sum(monto) from taca_pagos where creado >= ini and creado < fin), 0),
    'mrr', coalesce((r->>'pag_local')::numeric, 0) * coalesce((cfg->'precios'->>'local')::numeric, 49900)
         + coalesce((r->>'pag_encendido')::numeric, 0) * coalesce((cfg->'precios'->>'encendido')::numeric, 89900),
    'mes', p_mes);
  return r;
end $$;
grant execute on function public.taca_vt_metricas(text) to authenticated;

-- Datos de arranque (solo la primera vez).
insert into public.taca_vt_equipo (id, nombre, email, rol, admin, parte) values
  ('lucas', 'Lucas', 'lucastavano2020@gmail.com', 'socio', true, 50),
  ('daniel', 'Daniel', null, 'socio', false, 50),
  ('nahuel', 'Nahuel', null, 'vendedor', false, 0)
on conflict (id) do nothing;
insert into public.taca_vt_config (id, data) values (1, '{"precios":{"local":49900,"encendido":89900},"fijos":168020,"porLocal":3886,"fondoPct":20,"comision":"primer_mes"}')
on conflict (id) do nothing;
insert into public.taca_vt_objetivos (mes, miembro, contactos, demos, pruebas, ventas) values
  ('2026-11','grupo',60,6,3,2), ('2026-11','lucas',20,2,1,1), ('2026-11','daniel',20,2,1,1), ('2026-11','nahuel',20,2,1,0),
  ('2026-12','grupo',270,27,16,8), ('2026-12','lucas',90,9,6,3), ('2026-12','daniel',90,9,5,3), ('2026-12','nahuel',90,9,5,2)
on conflict do nothing;
insert into public.taca_vt_tareas (id, mes, titulo, asignado, vence, creado_por) values
  ('t1','2026-11','Imprimir 50 folletos A5 (frente y dorso)','lucas','2026-11-23','lucas'),
  ('t2','2026-11','Crear el local "Demo ta-ca" para mostrar la IA','lucas','2026-11-22','lucas'),
  ('t3','2026-11','Practicar la demo de 10 minutos dos veces','lucas','2026-11-22','lucas'),
  ('t4','2026-11','Practicar la demo de 10 minutos dos veces','daniel','2026-11-22','lucas'),
  ('t5','2026-11','Practicar la demo de 10 minutos dos veces','nahuel','2026-11-22','lucas'),
  ('t6','2026-11','Repartir las zonas de la lista de locales','todos','2026-11-23','lucas'),
  ('t7','2026-11','Publicar los 4 posts de Instagram (lun, mié, vie, dom)','nahuel','2026-11-29','lucas'),
  ('t8','2026-11','Decidir comisiones, fondo común y oferta de lanzamiento','todos','2026-11-23','lucas'),
  ('t9','2026-11','Bajar Zoho a Mail Lite','lucas','2026-12-02','lucas'),
  ('t10','2026-11','Pasar Vercel y Supabase a pago antes del primer cobro','lucas','2026-12-05','lucas')
on conflict (id) do nothing;
insert into public.taca_vt_contactos (id,nro,nombre,tipo,zona,direccion,telefono,whatsapp,maps,prioridad) values
('c1',1,'Almirante','Bar','Pichincha','Brown 3098','+54 341 749-9047',null,'https://www.google.com/maps/place/?q=place_id:ChIJjV6v1SKrt5URLDU_pd7SLgA','Alta'),
('c2',2,'Bon Scott','Bar','Pichincha','Pichincha 131','+54 9 341 211-8352','5493412118352','https://www.google.com/maps/place/?q=place_id:ChIJExaJZE6rt5URTA7-OJG6OuQ','Alta'),
('c3',3,'Cervario','Bar','Pichincha','Brown 2888',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJF8YWLUyrt5URM_OtSDA4cPM','Alta'),
('c4',4,'Corner Pichincha','Bar','Pichincha','Av. Francia 7','+54 341 589-8189',null,'https://www.google.com/maps/place/?q=place_id:ChIJTTnGfROrt5URWZpaYTLFaPs','Alta'),
('c5',5,'Grolar Bar','Bar','Pichincha','Pichincha Bis 2','+54 341 562-1947',null,'https://www.google.com/maps/place/?q=place_id:ChIJ6QL_nKWrt5URUuoxi7SMN24','Alta'),
('c6',6,'Möns Beer Garden','Cervecería','Pichincha','Av. Francia Bis 59',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJOQJzhU2rt5UR1SOuxNpodFI','Alta'),
('c7',7,'Refinería Restaurant','Restaurante','Pichincha','Rawson 443 bis','+54 9 341 695-1250','5493416951250','https://www.google.com/maps/place/?q=place_id:ChIJOaKEDUVTtpURjKuPKnMrdGs','Alta'),
('c8',8,'Casa Brava','Bar','Pichincha','Pichincha 120',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJ-7fyPoert5URKAon1CUlBVw','Media (local grande)'),
('c9',9,'Tanno''s Pizzas','Pizzería','Pichincha','Pichincha 38','+54 341 662-4850',null,'https://www.google.com/maps/place/?q=place_id:ChIJsfsirTCrt5URKSu0kb1ZeD4','Media'),
('c10',10,'Alvear and Nueve de Julio Grill','Restaurante','Centro','9 de Julio 2295','+54 341 449-3811',null,'https://www.google.com/maps/place/?q=place_id:ChIJUwxBz2urt5URDOJFImFGg50','Alta'),
('c11',11,'Bar Neco''s','Bar','Centro','Av. Carlos Pellegrini 3994','+54 341 437-4563',null,'https://www.google.com/maps/place/?q=place_id:ChIJr9npYKGst5UR3mB0RU_VeCI','Alta'),
('c12',12,'Bella Roma Pizzería','Pizzería','Centro','Sarmiento 1414',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJ2yrrAgCrt5URD22jlIoNJxA','Alta'),
('c13',13,'Birria','Bar','Centro','España 1501','+54 341 449-3776',null,'https://www.google.com/maps/place/?q=place_id:ChIJgcFfVBKrt5URSwdueg-ASQQ','Alta'),
('c14',14,'Bodegón Asturiano','Restaurante','Centro','San Luis 644','+54 341 674-1616',null,'https://www.google.com/maps/place/?q=place_id:ChIJH-yMD42rt5URJl73kgkEgys','Alta'),
('c15',15,'Bodegón Pueyrredón','Restaurante','Centro','Pueyrredón 398',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJ6YytKgCrt5URzAKQ8PPkxGs','Alta'),
('c16',16,'Bodegón de sabores 1852','Restaurante','Centro','3 de Febrero 2417','+54 341 255-3429',null,'https://www.google.com/maps/place/?q=place_id:ChIJwZ0ADQCrt5URZb2QpYPISt4','Alta'),
('c17',17,'Brooklyn | Crafters'' Garden','Bar','Centro','Tucumán 1294','+54 341 377-9444',null,'https://www.google.com/maps/place/?q=place_id:ChIJUy320CKrt5UR4BoyGaz0pmg','Alta'),
('c18',18,'Charles Cerveceria','Cervecería','Centro','San Juan 1827','+54 9 341 344-0175','5493413440175','https://www.google.com/maps/place/?q=place_id:ChIJ57FoAhWrt5URXzj_rB7vkUQ','Alta'),
('c19',19,'El Patio Multiespacio','Cervecería','Centro','España 1190','+54 341 281-7567',null,'https://www.google.com/maps/place/?q=place_id:ChIJQa9kbhSrt5UR4JnnDXyp9LQ','Alta'),
('c20',20,'Hamburguesas Extremas','Hamburguesería','Centro','Córdoba 1180',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJmdL6cQCrt5URdIUJOLe7LaU','Alta'),
('c21',21,'John''s Burgers Centro','Hamburguesería','Centro','Mendoza 1096',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJLb5AeNWrt5URNpOvl-5Qt7k','Alta'),
('c22',22,'La Bodeguita de Pichincha','Bar','Centro','Alvear 144',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJe3aa7eurt5UR2lvScGu8NIM','Alta'),
('c23',23,'La Rosario - Almacén de Pizzas','Pizzería','Centro',null,'+54 341 792-6006',null,'https://www.google.com/maps/place/?q=place_id:ChIJncB14MSrt5URgoVUxd4a1kY','Alta'),
('c24',24,'La Vizcachera cervecería','Cervecería','Centro','Av. Carlos Pellegrini 3702',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJvbZdJSutt5URCI66cRf5Giw','Alta'),
('c25',25,'Las Rosarinas','Pizzería','Centro','Rioja 2392','+54 341 447-0010',null,'https://www.google.com/maps/place/?q=place_id:ChIJpQ68EkGrt5URiTxm2qBaSyc','Alta'),
('c26',26,'Mosto Barrio Martin','Cervecería','Centro','San Juan 561',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJhUz2qOSrt5URwQOgy-866bU','Alta'),
('c27',27,'Mosto Echesortu','Bar','Centro','San Nicolás 1141',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJx-E3SQCrt5URl7s4Wq4GqZc','Alta'),
('c28',28,'Mosto Somos Cervezas','Cervecería','Centro','Pueyrredón 1096',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJfRmq_vWrt5UR-tYUzMsVFkk','Alta'),
('c29',29,'Mr. Tasty Rosario','Hamburguesería','Centro','Sarmiento 870','+54 341 542-8120',null,'https://www.google.com/maps/place/?q=place_id:ChIJyaX773ert5URNL6dX_UMyDo','Alta'),
('c30',30,'Olegario Almacén Boutique','Cervecería','Centro','Montevideo 2370','+54 341 257-3774',null,'https://www.google.com/maps/place/?q=place_id:ChIJLUeLVw6rt5UR5aplzO3M2KM','Alta'),
('c31',31,'Resto Bar Pico Fino','Bar','Centro','Av. San Martín 783','+54 341 424-7836',null,'https://www.google.com/maps/place/?q=place_id:ChIJT5ozcxmrt5UR8E5x-bOHfrM','Alta'),
('c32',32,'Ruin Bar','Bar','Centro','Jujuy 2230',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJf9v3f9urt5URt-GgGWNJP2A','Alta'),
('c33',33,'Vibra Bar','Bar','Centro','Salta 2250',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJP-nkZgCrt5URFCgqd4DCMeY','Alta'),
('c34',34,'Weiss Burger Rosario','Hamburguesería','Centro','Pres. Roca 749',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJbSEaRq2rt5URFXqM8NPi9-U','Alta'),
('c35',35,'LA BUSSOLA CENTRO','Restaurante','Centro','3 de Febrero 1314 BLB','+54 341 411-8030',null,'https://www.google.com/maps/place/?q=place_id:ChIJRaNoVBCrt5URjO6PIzWaR3M','Media'),
('c36',36,'La Fabrica "Bebidas De Pichincha"','Bar','Centro','Catamarca 2941','+54 341 270-9827',null,'https://www.google.com/maps/place/?q=place_id:ChIJeRvFZkSrt5UR9L1R8ZlK85c','Media'),
('c37',37,'Los Tres Hermanos','Pizzería','Centro','Vera Mujica 944','+54 341 581-4061',null,'https://www.google.com/maps/place/?q=place_id:ChIJB8DELFirt5URIn7oYm8GiRQ','Media'),
('c38',38,'Pizza Piazza','Pizzería','Centro','Córdoba 901 AWK','+54 341 448-2233',null,'https://www.google.com/maps/place/?q=place_id:ChIJSz58Wxmrt5URR2Jtxz90kz0','Media (local grande)'),
('c39',39,'Ronnie Mercado Zarpado','Hamburguesería','Centro','San Luis 1038','+54 341 588-0366',null,'https://www.google.com/maps/place/?q=place_id:ChIJRSD5l-Grt5UREFtV10FVDWM','Media'),
('c40',40,'Ronnie Pichincha','Hamburguesería','Centro','Santiago 102','+54 341 588-0366',null,'https://www.google.com/maps/place/?q=place_id:ChIJq7E7W0irt5URsWOBZBLytq4','Media (local grande)'),
('c41',41,'Bar Friends.','Bar','Abasto / Echesortu','HUE, Av. San Martín 4099','+54 341 613-3949',null,'https://www.google.com/maps/place/?q=place_id:ChIJsYcht7irt5URqbLk81ZOzxg','Alta'),
('c42',42,'Bros','Cervecería','Abasto / Echesortu','Av. Carlos Pellegrini 388 BTQ','+54 341 283-0537',null,'https://www.google.com/maps/place/?q=place_id:ChIJA2BZrQGrt5UR58wY8Lac1DA','Alta'),
('c43',43,'Burger House Grill Pellegrini','Hamburguesería','Abasto / Echesortu','Av. Carlos Pellegrini 916','+54 341 310-0808',null,'https://www.google.com/maps/place/?q=place_id:ChIJEw8WEd6rt5URC64QbefLL2s','Alta'),
('c44',44,'Charly Bodegón','Restaurante','Abasto / Echesortu','Entre Ríos 1798','+54 341 482-5039',null,'https://www.google.com/maps/place/?q=place_id:ChIJqYxR8A6rt5UREMJWcL3py4g','Alta'),
('c45',45,'El Leñador','Hamburguesería','Abasto / Echesortu','Sarmiento 1798 FVB','+54 341 239-1401',null,'https://www.google.com/maps/place/?q=place_id:ChIJiXAmRA-rt5URTwh0ZXVUqb8','Alta'),
('c46',46,'Fullero RestoBar','Cervecería','Abasto / Echesortu','Av. Carlos Pellegrini 1085','+54 341 504-9126',null,'https://www.google.com/maps/place/?q=place_id:ChIJ2ZDMMsWrt5UR_4MGACeVkCk','Alta'),
('c47',47,'La Perrería Beer & Food','Cervecería','Abasto / Echesortu','Av. San Martín 4869',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJt1tfpumrt5URnWsQh4aW7lA','Alta'),
('c48',48,'La Social Barrio Martin','Bar','Abasto / Echesortu','Zeballos 101','+54 341 243-3165',null,'https://www.google.com/maps/place/?q=place_id:ChIJbRaPTv6qt5UROKEQs9PjwXc','Alta'),
('c49',49,'Marvel Food Pellegrini','Hamburguesería','Abasto / Echesortu','Av. Carlos Pellegrini 1149',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJbRHXbACrt5URexFzz1Z7XOU','Alta'),
('c50',50,'Mosto Abasto','Bar','Abasto / Echesortu','Viamonte 1399','+54 341 572-3575',null,'https://www.google.com/maps/place/?q=place_id:ChIJEWZpowqrt5URFTFPD51lGHw','Alta'),
('c51',51,'Prego','Bar','Abasto / Echesortu','Cochabamba 1596','+54 341 749-1031',null,'https://www.google.com/maps/place/?q=place_id:ChIJ8-dDjPert5URrbSSZSOVdqI','Alta'),
('c52',52,'Stuttgart','Cervecería','Abasto / Echesortu','Av. Carlos Pellegrini 1910','+54 341 441-6117',null,'https://www.google.com/maps/place/?q=place_id:ChIJEV_fMW2rt5URXEkFmconq2E','Alta'),
('c53',53,'Wilson Pizzas','Pizzería','Abasto / Echesortu','Av. Carlos Pellegrini 1048 BTX','+54 341 425-1080',null,'https://www.google.com/maps/place/?q=place_id:ChIJN6hloxyrt5URQM0u2uZie14','Alta'),
('c54',54,'BARREL Abasto','Cervecería','Abasto / Echesortu','La Paz 1298','+54 9 341 228-4361','5493412284361','https://www.google.com/maps/place/?q=place_id:ChIJa9KJRQCrt5URil1FFTKllEc','Media'),
('c55',55,'Bar Restaurante','Bar','Abasto / Echesortu','Av. San Martín 6009',null,null,'https://www.google.com/maps/place/?q=place_id:ChIJtbRxGDSrt5URa4m2wdMUPmc','Media'),
('c56',56,'Club de Pizzas','Pizzería','Abasto / Echesortu','Av. Carlos Pellegrini 1295','+54 341 486-0667',null,'https://www.google.com/maps/place/?q=place_id:ChIJRRk0Vw6rt5URhyy2KzwIAP8','Media (local grande)'),
('c57',57,'EL CARLO DEL ABASTO','Bar','Abasto / Echesortu','España 1894','+54 341 750-3296',null,'https://www.google.com/maps/place/?q=place_id:ChIJm5aYKpqrt5UR195pbPARJco','Media'),
('c58',58,'Espacio World','Cervecería','Abasto / Echesortu','Av. Carlos Pellegrini 1647','+54 341 355-6794',null,'https://www.google.com/maps/place/?q=place_id:ChIJ30MviSurt5URg06H2BwjifE','Media (local grande)'),
('c59',59,'Irineo','Bar','Abasto / Echesortu','Av. San Martín 4502','+54 341 462-4049',null,'https://www.google.com/maps/place/?q=place_id:ChIJtSTiOcGrt5URstmk-OUubU0','Media (local grande)'),
('c60',60,'King Beer','Cervecería','Abasto / Echesortu','Av. Carlos Pellegrini 1727','+54 341 368-0202',null,'https://www.google.com/maps/place/?q=place_id:ChIJQZkhe5qrt5UR0wYD9yKxx5s','Media (local grande)'),
('c61',61,'Pizza House','Pizzería','Abasto / Echesortu','Montevideo 1378','+54 341 217-4002',null,'https://www.google.com/maps/place/?q=place_id:ChIJUdzrGcWrt5URC4THJFLDCPA','Media'),
('c62',62,'Via Apia Pizzería','Pizzería','Abasto / Echesortu','Av. Carlos Pellegrini 961','+54 341 481-3174',null,'https://www.google.com/maps/place/?q=place_id:ChIJ13W26wWrt5URXpHi6ZBjI2Q','Media (local grande)'),
('c63',63,'Barro Pichincha','Restaurante','Puerto Norte / Refinería','Alvear 41','+54 341 283-8386',null,'https://www.google.com/maps/place/?q=place_id:ChIJwbbu-P-rt5UR9gVUUV8-Skw','Alta'),
('c64',64,'Bajada España','Restaurante','Puerto Norte / Refinería',null,'+54 341 449-6801',null,'https://www.google.com/maps/place/?q=place_id:ChIJB0LkgzCrt5URwGH6mQUV7s0','Media (local grande)'),
('c65',65,'El Dorado - Bodegón de Río','Restaurante','Puerto Norte / Refinería','Emilio O Schiffner 1580','+54 341 541-2650',null,'https://www.google.com/maps/place/?q=place_id:ChIJl4cPw_2rt5URD_btpxjWjf4','Media (local grande)'),
('c66',66,'BAR LA ROMERIA DE SAN ANTONIO','Bar','Barrio Martin / Sur','Av. San Martín 3372','+54 341 274-9671',null,'https://www.google.com/maps/place/?q=place_id:ChIJD9NVP7urt5UReXWPzBcxGME','Alta'),
('c67',67,'Borussia Cervezas','Cervecería','Barrio Martin / Sur','Av. San Martín 3440','+54 341 312-4106',null,'https://www.google.com/maps/place/?q=place_id:ChIJX4fNcrurt5UR7wrU_jkKsWo','Alta'),
('c68',68,'Parrilla Bodegón Centro Entrerriano','Parrilla / Bodegón','Barrio Martin / Sur','Buenos Aires 2565','+54 341 482-0307',null,'https://www.google.com/maps/place/?q=place_id:ChIJLxRt0Kirt5URQH9f-NipNSs','Alta'),
('c69',69,'BIRIQUITINA - Experiencias y café','Café-bar','Barrio Martin / Sur','Av. San Martín 3515','+54 341 212-7935',null,'https://www.google.com/maps/place/?q=place_id:ChIJgTyuhIOrt5URTwvUI8-K518','Media'),
('c70',70,'Bar "Lido"','Bar','Barrio Martin / Sur','Av. San Martín 3142','+54 341 481-1027',null,'https://www.google.com/maps/place/?q=place_id:ChIJ-fSuwqSrt5URCq5js2smBb8','Media (local grande)'),
('c71',71,'El León','Restaurante','Barrio Martin / Sur','Leandro N. Alem 2291','+54 341 366-2291',null,'https://www.google.com/maps/place/?q=place_id:ChIJn-7urNWrt5URN4--TvWX0WI','Media (local grande)'),
('c72',72,'Cantina del C.A.F.','Bar','Fisherton','Chassaing 1650','+54 341 390-8880',null,'https://www.google.com/maps/place/?q=place_id:ChIJB86AdN5TtpURrgLN4q8PILQ','Alta'),
('c73',73,'LA ANDONIA RESTAURANT','Restaurante','Fisherton','José M. Rosa 993','+54 341 350-6593',null,'https://www.google.com/maps/place/?q=place_id:ChIJ5RV5Y3NTtpURXDY8t3Q0gU4','Alta'),
('c74',74,'Nenina Fisherton','Bar','Fisherton','A. J. Paz 1065 Bis⁣⁣','+54 341 268-7770',null,'https://www.google.com/maps/place/?q=place_id:ChIJUQPyUmtNtpURAamNAFn3THI','Alta'),
('c75',75,'Palo Borracho','Bar','Fisherton','Av. Eva Perón 7849','+54 341 307-6917',null,'https://www.google.com/maps/place/?q=place_id:ChIJD6V3kdxStpURTQrbs0gdkBk','Alta'),
('c76',76,'Picaña Parrilla Restaurante','Parrilla / Bodegón','Fisherton','Schweitzer, Juan Pablo II 9063','+54 341 503-9986',null,'https://www.google.com/maps/place/?q=place_id:ChIJJR9J74NTtpURDlbMTlSCDao','Alta'),
('c77',77,'la destileria','Cervecería','Fisherton','Av. Eva Perón 7801','+54 341 236-7217',null,'https://www.google.com/maps/place/?q=place_id:ChIJHc0PfNxStpUR0qzBJUskFYU','Alta'),
('c78',78,'Bar Antartida','Bar','Fisherton','199 Sánchez de Loria Bis 101','+54 341 451-1441',null,'https://www.google.com/maps/place/?q=place_id:ChIJW915xdxStpUR0VjumDM1Y8Q','Media (local grande)'),
('c79',79,'Jardín Restobar','Bar','Fisherton','Rodó 166','+54 341 703-9788',null,'https://www.google.com/maps/place/?q=place_id:ChIJaY-yJ2tTtpURp1GSk5ZvdCI','Media'),
('c80',80,'Restaurante Gimme Shelter House','Restaurante','Fisherton','Blvd. Argentino 8013','+54 9 341 592-1404','5493415921404','https://www.google.com/maps/place/?q=place_id:ChIJD4UBQjhTtpURFfD_oAt5OR0','Media (local grande)')
on conflict (id) do nothing;
-- Resumen del equipo de ventas para el Panel Roman Web de la app.
create or replace function public.taca_vt_resumen(p_mes text default to_char(now() at time zone 'America/Argentina/Buenos_Aires','YYYY-MM'))
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ini timestamptz; fin timestamptz;
begin
  if taca_vt_yo_id() is null then return null; end if;
  ini := (p_mes || '-01')::timestamp at time zone 'America/Argentina/Buenos_Aires';
  fin := ini + interval '1 month';
  return jsonb_build_object(
    'mes', p_mes,
    'metricas', taca_vt_metricas(p_mes),
    'config', (select data from taca_vt_config where id = 1),
    'equipo', coalesce((select jsonb_agg(jsonb_build_object('id',id,'nombre',nombre,'rol',rol,'parte',parte,'email',email is not null) order by creado) from taca_vt_equipo where activo), '[]'::jsonb),
    'logros', coalesce((select jsonb_object_agg(miembro, t) from (select miembro, jsonb_object_agg(tipo, n) t from (select miembro, tipo, count(*) n from taca_vt_actividad where ts >= ini and ts < fin group by 1,2) a group by 1) b), '{}'::jsonb),
    'comisiones', coalesce((select jsonb_object_agg(miembro, s) from (select miembro, sum(coalesce(monto,0)) s from taca_vt_actividad where tipo='venta' and ts >= ini and ts < fin group by 1) c), '{}'::jsonb),
    'objetivos', coalesce((select jsonb_object_agg(miembro, jsonb_build_object('contactos',contactos,'demos',demos,'pruebas',pruebas,'ventas',ventas)) from taca_vt_objetivos where mes = p_mes), '{}'::jsonb),
    'tareas', jsonb_build_object('total',(select count(*) from taca_vt_tareas where mes=p_mes),'hechas',(select count(*) from taca_vt_tareas where mes=p_mes and hecho)),
    'embudo', coalesce((select jsonb_object_agg(estado, n) from (select estado, count(*) n from taca_vt_contactos group by 1) e), '{}'::jsonb),
    'ultimas', coalesce((select jsonb_agg(x order by x->>'ts' desc) from (select jsonb_build_object('ts',a.ts,'miembro',a.miembro,'tipo',a.tipo,'local',c.nombre) x from taca_vt_actividad a left join taca_vt_contactos c on c.id=a.contacto_id order by a.ts desc limit 8) u), '[]'::jsonb)
  );
end $$;
grant execute on function public.taca_vt_resumen(text) to authenticated;
-- Permisos base de las tablas del equipo (las políticas RLS deciden qué ve cada uno).
grant select, insert, update, delete on public.taca_vt_equipo, public.taca_vt_config, public.taca_vt_contactos, public.taca_vt_actividad, public.taca_vt_tareas, public.taca_vt_objetivos to authenticated;
grant usage, select on sequence public.taca_vt_actividad_id_seq to authenticated;
grant execute on function public.taca_vt_yo_id(), public.taca_vt_soy_admin(), public.taca_vt_soy_socio() to authenticated;
alter table public.taca_vt_contactos add column if not exists hora text;  -- hora de la cita (HH:MM)
