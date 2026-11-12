# Audiências CT — convidados (colaborativo)

Lista de **convidados** de audiências públicas das Comissões Temporárias (Câmara), com dados da [API Dados Abertos](https://dadosabertos.camara.leg.br/).

## Ver localmente

1. Execute `start-server.cmd`.
2. Abra **http://localhost:5175/**
3. Escolha a comissão → toque na audiência → marque presença e fotos.

No PC, **vários navegadores no mesmo `localhost`** compartilham o arquivo `shared-event-state.json` (teste de equipe na mesma máquina).

## Colaboração na internet (Netlify + Supabase)

Para **todos os celulares/PCs** verem o mesmo evento ao mesmo tempo:

1. Rode `SUPABASE_SETUP.sql` no Supabase.
2. Configure `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` no Netlify.
3. Publique o site.

Detalhes: `DEPLOY_NETLIFY_SUPABASE.md` (mesmo padrão do mapa de plenário).

## Celular

No Chrome do celular, abra o site e toque em **Instalar**. Se o botão não aparecer, use o menu ⋮ → **Instalar app**.

## Uso

- Toque na **bolinha**: enviar ou trocar foto do convidado.
- Botões **Pendente / Chegou / Não vem**: visíveis para quem abrir aquele evento.
- **Chegou** também grava **Participou presencialmente** no PLD, se a extensão estiver instalada e o código da reunião estiver preenchido. Veja `extensao-pld`.

## Presença no PLD

O site não entra no PLD sozinho: a sessão fica no navegador de quem está logado. A pasta `extensao-pld` faz a ponte.

1. No Chrome ou no Edge: Extensões → ativar modo do desenvolvedor → **Carregar sem compactação**.
2. Escolha a pasta `audiencias-ct-web/extensao-pld`.
3. Deixe o PLD aberto e logado (Gestão de Reuniões).
4. No evento do carômetro, informe o código da reunião do PLD (o número longo, por exemplo `2100026540`).
5. Clique em **Chegou**. O participante com o mesmo nome passa para **Participou presencialmente**.
- Atualização automática a cada poucos segundos enquanto a página está aberta.

## Limitações

- Convidados vêm do texto “Convidados:” na descrição do evento (parser simples).
- Sem reconhecimento facial.
- Fotos grandes ocupam espaço no banco; use imagens razoáveis.
