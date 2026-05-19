# Deploy com estado colaborativo (Supabase)

Igual ao mapa de plenário: **todos que abrirem o mesmo evento** veem as mesmas marcações (chegou / não vem) e **as mesmas fotos**.

## 1) Tabela no Supabase

1. Abra o projeto no [Supabase](https://supabase.com/).
2. SQL Editor → execute **todo** o conteúdo de `SUPABASE_SETUP.sql`.
3. Se o Supabase avisar sobre RLS: use o script atualizado (já habilita RLS e bloqueia acesso direto pelo navegador). **Não** use “Executar sem RLS”.

## 2) Variáveis no Netlify

Em **Site settings → Environment variables**:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

(Pode ser o **mesmo projeto** do mapa de plenário; a tabela é `audiencia_event_state`.)

## 3) Publicar

Publique a pasta `audiencias-ct-web` no Netlify. O `netlify.toml` já expõe `/api/state`.

## 4) Testar

1. `GET https://SEU-SITE.netlify.app/api/state?eventId=12345` → JSON com `version`.
2. Abra a mesma audiência em **dois celulares/navegadores**.
3. Marque um convidado como **Chegou** em um aparelho → em alguns segundos aparece no outro.

## Local (sem Supabase)

Com `start-server.cmd`, o estado fica em `shared-event-state.json` na pasta do projeto — **todos os navegadores que usam o mesmo `localhost` compartilham** esse arquivo (útil para teste na equipe na mesma rede).

Para colaboração na internet, use o deploy no Netlify com Supabase.
