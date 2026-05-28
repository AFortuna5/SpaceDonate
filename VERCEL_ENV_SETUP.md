# Configuração de Variáveis de Ambiente no Vercel

Para que o OAuth do YouTube e Twitch funcione no Vercel, é necessário adicionar as seguintes variáveis de ambiente no dashboard do Vercel:

## Variáveis Necessárias

### YouTube OAuth
- `YOUTUBE_CLIENT_ID`: Seu Client ID do Google OAuth
- `YOUTUBE_CLIENT_SECRET`: Seu Client Secret do Google OAuth  
- `YOUTUBE_REDIRECT_URI`: `https://space-donate.vercel.app/auth/youtube/callback`

### Twitch OAuth
- `TWITCH_CLIENT_ID`: Seu Client ID do Twitch
- `TWITCH_CLIENT_SECRET`: Seu Client Secret do Twitch
- `TWITCH_REDIRECT_URI`: `https://space-donate.vercel.app/auth/twitch/callback`

### Banco de Dados
- `DATABASE_URL`: URL de conexão PostgreSQL (Neon/Railway/etc)

### Aplicação
- `JWT_SECRET`: Chave secreta para assinar JWTs
- `NEXT_PUBLIC_API_URL`: `https://space-donate.vercel.app`
- `PUBLIC_BASE_URL`: `https://space-donate.vercel.app`

### AbakatePay (Opcional)
- `ABACATEPAY_API_KEY`: Sua chave de API
- `ABACATEPAY_WEBHOOK_SECRET`: Secret do webhook

## Como Adicionar no Vercel

1. Acesse https://vercel.com/afortuna5/space-donate/settings/environment-variables
2. Clique em "Add New"
3. Cole cada variável com seu valor
4. Selecione os ambientes (Production, Preview, Development)
5. Salve e faça um novo deployment

As variáveis de ambiente serão carregadas automaticamente em produção.
