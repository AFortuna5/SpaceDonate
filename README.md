
# SpaceDonate

Plataforma de doações para streamers construída com Next.js, Prisma e PostgreSQL.

## Stack
- Next.js 15
- TypeScript
- Prisma ORM
- PostgreSQL
- JWT Authentication
- Vercel

## Instalação

```bash
npm install
```

Configure `.env` baseado no `.env.example`

## Banco

```bash
npx prisma generate
npx prisma migrate dev
```

## Desenvolvimento

```bash
npm run dev
```

## Produção

```bash
npm run build
npm start
```
