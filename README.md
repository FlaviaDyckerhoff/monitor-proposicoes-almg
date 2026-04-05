# 🏛️ Monitor Proposições MG — ALMG

Monitora automaticamente a API de Dados Abertos da Assembleia Legislativa de Minas Gerais e envia email quando há proposições novas. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

---

## Como funciona

1. O GitHub Actions roda o script nos horários configurados
2. O script chama a API pública da ALMG (`dadosabertos.almg.gov.br`)
3. Compara as proposições recebidas com as já registradas no `estado.json`
4. Se há proposições novas → envia email com a lista organizada por tipo
5. Salva o estado atualizado no repositório

---

## API utilizada

- **Base:** `https://dadosabertos.almg.gov.br`
- **Endpoint:** `GET /api/v2/proposicoes/pesquisa/direcionada`
- **Parâmetros:** `ano`, `tp` (tamanho de página), `p` (página), `ord=0` (mais recentes primeiro)
- **Autenticação:** nenhuma — API pública
- **Rate limit:** mínimo 1s entre requisições (respeitado com sleep de 1200ms)

---

## Estrutura do repositório

```
monitor-proposicoes-mg/
├── monitor.js          # Script principal
├── package.json        # Dependências (só nodemailer)
├── estado.json         # Estado salvo automaticamente pelo workflow
├── README.md           # Este arquivo
└── .github/
    └── workflows/
        └── monitor.yml # Workflow do GitHub Actions
```

---

## Setup

### PARTE 1 — Preparar o Gmail

**1.1** Acesse [myaccount.google.com/security](https://myaccount.google.com/security)

**1.2** Certifique-se de que a **Verificação em duas etapas** está ativa.

**1.3** Busque por **"Senhas de app"** e clique.

**1.4** Digite `monitor-almg` e clique em **Criar**.

**1.5** Copie a senha de **16 letras** — ela só aparece uma vez.

> Se já tem App Password de outro monitor, pode reutilizar.

---

### PARTE 2 — Criar o repositório no GitHub

**2.1** Acesse [github.com](https://github.com) → **+ → New repository**

**2.2** Preencha:
- **Repository name:** `monitor-proposicoes-mg`
- **Visibility:** Private

**2.3** Clique em **Create repository**

---

### PARTE 3 — Fazer upload dos arquivos

**3.1** Na página do repositório, clique em **"uploading an existing file"**

**3.2** Faça upload de:
```
monitor.js
package.json
README.md
```
Clique em **Commit changes**.

**3.3** Para o workflow: **Add file → Create new file**, digite o nome:
```
.github/workflows/monitor.yml
```
Cole o conteúdo do `monitor.yml` e clique em **Commit changes**.

---

### PARTE 4 — Configurar os Secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail (ex: seuemail@gmail.com) |
| `EMAIL_SENHA` | senha de 16 letras do App Password (sem espaços) |
| `EMAIL_DESTINO` | email onde quer receber os alertas |

---

### PARTE 5 — Testar

**Actions → Monitor Proposições MG → Run workflow → Run workflow**

Aguarde ~30 segundos (a API da ALMG é mais lenta que SAPL/ALEP por ter rate limit).

O **primeiro run** envia email com as proposições recentes do ano e salva o estado. A partir do segundo run, só notifica novidades.

---

## Observações

- O `estado.json` mantém no máximo 2000 IDs para não crescer indefinidamente
- O script busca no máximo 20 páginas por execução (1000 proposições) como proteção
- O link de cada proposição aponta para o portal da ALMG
