const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ─── Configuração ────────────────────────────────────────────────────────────
const API_BASE = 'https://dadosabertos.almg.gov.br';
const ESTADO_PATH = path.join(__dirname, 'estado.json');
const ANO_ATUAL = new Date().getFullYear();
const ITENS_POR_PAGINA = 50;

// ─── Estado ──────────────────────────────────────────────────────────────────
function carregarEstado() {
  if (fs.existsSync(ESTADO_PATH)) {
    return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
}

// ─── Sleep (respeita rate limit da ALMG: mín 1s entre requisições) ───────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Busca proposições de uma página ─────────────────────────────────────────
async function buscarPagina(pagina) {
  const params = new URLSearchParams({
    ano: ANO_ATUAL,
    tp: ITENS_POR_PAGINA,
    p: pagina,
    ord: 0,       // 0 = data de publicação decrescente (mais recentes primeiro)
    formato: 'json'
  });

  const url = `${API_BASE}/api/v2/proposicoes/pesquisa/direcionada?${params}`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ao buscar página ${pagina}`);
  }

  const json = await resp.json();
  return json.resultadoPesquisa || {};
}

// ─── Busca todas as proposições novas ────────────────────────────────────────
async function buscarProposicoesNovas(vistas) {
  const visitasSet = new Set(vistas);
  const novas = [];
  let pagina = 1;
  let totalPaginas = 1;

  do {
    if (pagina > 1) await sleep(1200); // respeita rate limit (mín 1s)

    const resultado = await buscarPagina(pagina);
    const itens = resultado.listaItem || [];
    const total = resultado.noOcorrencias || 0;
    totalPaginas = Math.ceil(total / ITENS_POR_PAGINA);

    console.log(`Página ${pagina}/${totalPaginas} — ${itens.length} proposições`);

    let encontrouTodasVistas = false;

    for (const item of itens) {
      const id = item.codigo || `${item.siglaTipoProjeto}-${item.numero}-${item.ano}`;
      if (visitasSet.has(id)) {
        // Chegamos em proposições já conhecidas — podemos parar
        encontrouTodasVistas = true;
        break;
      }
      novas.push({
        id,
        tipo: item.siglaTipoProjeto || item.tipoProjeto || 'OUTROS',
        numero: item.numero || '',
        ano: item.ano || ANO_ATUAL,
        autor: item.autor || item.nome || 'Não informado',
        ementa: item.ementa || item.resumo || '',
        data: item.dataPublicacao || '',
        link: `https://www.almg.gov.br/processo-legislativo/proposicoes/proposicao/?ano=${item.ano}&num=${item.numero}&tipo=${item.siglaTipoProjeto}`
      });
    }

    if (encontrouTodasVistas) break;
    pagina++;

  } while (pagina <= totalPaginas && pagina <= 20); // limite de segurança: 20 páginas

  return novas;
}

// ─── Monta o email ────────────────────────────────────────────────────────────
function montarEmail(proposicoes) {
  // Agrupa por tipo
  const grupos = {};
  for (const p of proposicoes) {
    const tipo = p.tipo || 'OUTROS';
    if (!grupos[tipo]) grupos[tipo] = [];
    grupos[tipo].push(p);
  }

  // Ordena tipos e dentro de cada tipo por número decrescente
  const tiposOrdenados = Object.keys(grupos).sort();
  for (const tipo of tiposOrdenados) {
    grupos[tipo].sort((a, b) => Number(b.numero) - Number(a.numero));
  }

  let html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
      <h2 style="color: #1a3a5c; border-bottom: 2px solid #1a3a5c; padding-bottom: 8px;">
        🏛️ ALMG — ${proposicoes.length} nova${proposicoes.length > 1 ? 's' : ''} proposiç${proposicoes.length > 1 ? 'ões' : 'ão'} (${ANO_ATUAL})
      </h2>
  `;

  for (const tipo of tiposOrdenados) {
    const itens = grupos[tipo];
    html += `
      <h3 style="color: #2c5f8a; margin-top: 24px; margin-bottom: 8px;">
        ${tipo} <span style="font-weight:normal; font-size:0.9em;">(${itens.length})</span>
      </h3>
    `;
    for (const p of itens) {
      const dataFmt = p.data
        ? p.data.replace(/(\d{4})(\d{2})(\d{2})/, '$3/$2/$1')
        : '';
      html += `
        <div style="border-left: 3px solid #2c5f8a; padding: 8px 12px; margin-bottom: 10px; background: #f8fafc;">
          <div style="font-weight: bold;">
            <a href="${p.link}" style="color: #1a3a5c; text-decoration: none;">
              ${p.tipo} ${p.numero}/${p.ano}
            </a>
            ${dataFmt ? `<span style="font-weight:normal; color:#666; font-size:0.85em;"> — ${dataFmt}</span>` : ''}
          </div>
          <div style="color: #444; margin: 4px 0; font-size: 0.92em;">${p.ementa || '(sem ementa)'}</div>
          <div style="color: #666; font-size: 0.85em;">Autor: ${p.autor}</div>
        </div>
      `;
    }
  }

  html += `
      <hr style="margin-top: 30px; border: none; border-top: 1px solid #ddd;">
      <p style="color: #999; font-size: 0.8em; text-align: center;">
        Monitor automático — Assembleia Legislativa de Minas Gerais<br>
        Dados: <a href="https://dadosabertos.almg.gov.br" style="color:#999;">dadosabertos.almg.gov.br</a>
      </p>
    </div>
  `;

  return html;
}

// ─── Envia email ──────────────────────────────────────────────────────────────
async function enviarEmail(proposicoes) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_REMETENTE,
      pass: process.env.EMAIL_SENHA
    }
  });

  const html = montarEmail(proposicoes);
  const assunto = `[ALMG] ${proposicoes.length} nova${proposicoes.length > 1 ? 's' : ''} proposiç${proposicoes.length > 1 ? 'ões' : 'ão'} — ${new Date().toLocaleDateString('pt-BR')}`;

  await transporter.sendMail({
    from: process.env.EMAIL_REMETENTE,
    to: process.env.EMAIL_DESTINO,
    subject: assunto,
    html
  });

  console.log(`Email enviado: "${assunto}"`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Monitor ALMG — ${new Date().toISOString()} ===`);

  const estado = carregarEstado();
  console.log(`Estado carregado: ${estado.proposicoes_vistas.length} proposições conhecidas`);

  const novas = await buscarProposicoesNovas(estado.proposicoes_vistas);
  console.log(`Novas proposições encontradas: ${novas.length}`);

  if (novas.length > 0) {
    await enviarEmail(novas);

    // Atualiza estado: adiciona novas IDs ao início, mantém histórico razoável
    const todasIds = [...novas.map(p => p.id), ...estado.proposicoes_vistas];
    // Limita a 2000 IDs para não inflar o estado.json indefinidamente
    estado.proposicoes_vistas = [...new Set(todasIds)].slice(0, 2000);
  } else {
    console.log('Nenhuma proposição nova. Email não enviado.');
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
  console.log('Estado salvo.');
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
