-- ta-ca · base de datos en Supabase
-- Pegar entero en Supabase › SQL Editor › New query › Run. Se puede correr más de una vez.

create table if not exists public.taca_locales (
  id          text primary key,
  data        jsonb not null,
  version     integer not null default 1,
  updated_at  timestamptz not null default now()
);

-- Nadie lee ni escribe la tabla directo: todo pasa por las funciones de abajo.
alter table public.taca_locales enable row level security;
revoke all on public.taca_locales from anon, authenticated;

-- Equipos del personal: leer el estado completo del local.
create or replace function public.taca_leer(p_id text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('data', data, 'version', version) from taca_locales where id = p_id;
$$;

-- Versión actual (para saber si hay cambios sin bajar todo).
create or replace function public.taca_version(p_id text)
returns integer language sql security definer set search_path = public as $$
  select version from taca_locales where id = p_id;
$$;

-- Equipos del personal: guardar con control de versión.
-- Si otro equipo guardó antes, devuelve ok=false con lo último para fusionar los cambios.
create or replace function public.taca_guardar(p_id text, p_data jsonb, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r taca_locales%rowtype;
begin
  select * into r from taca_locales where id = p_id for update;
  if not found then
    insert into taca_locales(id, data, version) values (p_id, p_data, 1);
    return jsonb_build_object('ok', true, 'version', 1);
  end if;
  if r.version <> p_version then
    return jsonb_build_object('ok', false, 'data', r.data, 'version', r.version);
  end if;
  update taca_locales set data = p_data, version = r.version + 1, updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'version', r.version + 1);
end $$;

-- Celular del cliente (QR): solo la carta, el stock y los pedidos de SU mesa. Sin caja, costos ni clientes.
create or replace function public.taca_carta(p_id text, p_mesa integer)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'version', version,
    'negocio', data->'negocio',
    'mesas',   data->'mesas',
    'platos',  data->'platos',
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

-- Celular del cliente (QR): hacer un pedido, llamar al mozo o pedir la cuenta.
-- El pedido descuenta el stock y toma el número acá, en el servidor, para que nunca se pisen.
create or replace function public.taca_cliente(p_id text, p_tipo text, p_mesa integer,
                                               p_pedido jsonb default null, p_consumo jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d jsonb; v integer; k text; c numeric; idx integer; st numeric; n integer;
  ahora bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  select data, version into d, v from taca_locales where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Local no encontrado'); end if;
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

grant execute on function public.taca_leer(text), public.taca_version(text),
  public.taca_guardar(text, jsonb, integer), public.taca_carta(text, integer),
  public.taca_cliente(text, text, integer, jsonb, jsonb) to anon, authenticated;
