const FICHA_URL = process.env.FICHA_URL || 'https://doe.monitorlegislativo.com.br/ficha';

function fichaEmailButtonHtml() {
  return '<div style="background:#eef6ff;border:1px solid #c7ddf2;border-radius:6px;padding:11px 13px;margin:12px 0;color:#173d63;font-size:13px;line-height:1.45">' +
    '<strong>Ficha</strong><br>' +
    '<span>Cole o link oficial de uma proposição para criar ficha e acelerar a revisão/cadastro.</span><br>' +
    '<a href="' + FICHA_URL + '" style="display:inline-block;background:#0f3d5c;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-weight:bold;margin-top:8px">Criar ficha</a>' +
    '</div>';
}

const CONTROLE03_FORCE_LATEST = String(process.env.CONTROLE03_FORCE_LATEST || '').trim() === '1';
const nodemailer = require('nodemailer');
let promoverInteresseClienteProposicao = (_item, atuais) => Array.isArray(atuais) ? atuais : [];
try {
  try {
    ({ promoverInteresseClienteProposicao } = require('./client_interest_matcher_js'));
  } catch (_localErr) {
    ({ promoverInteresseClienteProposicao } = require('../../agents/pautas/client_interest_matcher_js'));
  }
} catch (err) {
  console.warn('⚠️ Matcher cliente/palavra comum indisponível; usando destaque legado: ' + err.message);
}

function mlClientInterestContext() {
  return {
    uf: typeof CLIENT_INTEREST_UF !== 'undefined' ? CLIENT_INTEREST_UF : (process.env.CLIENT_INTEREST_UF || process.env.UF || ''),
    municipio: typeof CLIENT_INTEREST_MUNICIPIO !== 'undefined' ? CLIENT_INTEREST_MUNICIPIO : (process.env.CLIENT_INTEREST_MUNICIPIO || process.env.MUNICIPIO || ''),
    casa: typeof CASA_RADAR03 !== 'undefined' ? CASA_RADAR03 : (process.env.CASA_RADAR03 || process.env.CASA || ''),
  };
}

const fs = require('fs');
const path = require('path');
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'ALMG';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';


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

function montarLinkProposicao(item) {
  const tipo = encodeURIComponent(item.siglaTipoProjeto || item.tipoProjeto || 'OUTROS');
  const numero = encodeURIComponent(item.numero || '');
  const ano = encodeURIComponent(item.ano || ANO_ATUAL);
  return `https://www.almg.gov.br/projetos-de-lei/${tipo}/${numero}/${ano}`;
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
  return json.resultado || {};
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
        ementa: item.ementa || item.assunto || item.resumo || '',
        data: item.dataPublicacao || '',
        link: montarLinkProposicao(item)
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
    <div style="font-family: Arial, sans-serif; width: 100%; max-width: 920px; margin: 0 auto;">
      <h2 style="color: #1a3a5c; border-bottom: 2px solid #1a3a5c; padding-bottom: 8px;">
        🏛️ Assembleia Legislativa de Minas Gerais — ${proposicoes.length} nova${proposicoes.length > 1 ? 's' : ''} proposiç${proposicoes.length > 1 ? 'ões' : 'ão'} (${ANO_ATUAL})
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

const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra'
];

const CLIENTES_INATIVOS_NAO_DESTACAR = [
  'CVC', 'DIAGEO', 'Femsa', 'Lalamove', 'lalamove',
  'Maersk', 'Matrix', 'Rei do Pitaco', 'Sanofi', 'Syngenta',
  'Ypê', 'Ype', 'Braskem', 'Vital', 'Natural Energia',
  'Pacto Pela Fome', 'TikTok', 'Norte Energia', 'Mac Jee',
  'Solar', 'Grupo Simões', 'Grupo Simoes'
];

function clienteAtivoParaDestaque(nome) {
  return !CLIENTES_INATIVOS_NAO_DESTACAR.some(inativo => inativo.toLowerCase() === String(nome || '').toLowerCase());
}

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    if (!clienteAtivoParaDestaque(nome)) continue;
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return promoverInteresseClienteProposicao(p, achados, mlClientInterestContext());
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !(String(p.ementa).includes('Cliente citado:') || String(p.ementa).includes('CLIENTE CITADO:'))) {
      p.ementa = String(p.ementa).trim() + ' | 🆘 CLIENTE CITADO: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .filter(clienteAtivoParaDestaque)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#fff1f2;color:#991b1b;font-weight:800;border:1px solid #fecdd3;border-radius:3px;padding:1px 4px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+(?:🆘\s*)?CLIENTE CITADO:\s+|\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | 🆘 CLIENTE CITADO: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#fff1f2;border:1px solid #fb7185;color:#991b1b;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0">' +
    '🆘 CLIENTE CITADO: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function radar03Identificacao(p) {
  return String(p?.identificacao ?? p?.proposicao ?? p?.rotulo ?? p?.titulo ?? '').trim();
}

function radar03Tipo(p) {
  const direto = String(p?.tipo ?? p?.sigla ?? '').trim();
  if (direto) return direto;
  const m = radar03Identificacao(p).match(/^([A-Za-zÀ-ÿ0-9.-]+(?:\s+[A-Za-zÀ-ÿ0-9.-]+){0,2})\s+\d/i);
  return m ? m[1].trim() : '';
}

function clientesCitadosResumoEmail(novas) {
  const nomes = [];
  for (const p of novas || []) {
    for (const nome of (Array.isArray(p && p.clientesCitados) ? p.clientesCitados : [])) {
      if (nome && !nomes.some(n => n.toLowerCase() === String(nome).toLowerCase())) nomes.push(String(nome));
    }
  }
  return nomes;
}

function assuntoEmailClienteCitado(novas, assuntoBase) {
  const nomes = clientesCitadosResumoEmail(novas);
  if (!nomes.length) return assuntoBase;
  const lista = nomes.slice(0, 3).join(', ') + (nomes.length > 3 ? ' +' + (nomes.length - 3) : '');
  const base = String(assuntoBase || '');
  return base.startsWith('🆘') ? base : '🆘 🆘 CLIENTE CITADO: ' + lista + ' | ' + base;
}

function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (numero) {
    if (numero.includes('/') || !ano) return numero;
    return numero + '/' + ano;
  }
  const m = radar03Identificacao(p).match(/(S\/N|\d+\s*\/\s*\d{2,4}|\/\d{2,4}|\d+)/i);
  return m ? m[1].replace(/\s+/g, '') : '';
}


function radar03NumeroPartes(p) {
  const numeroRaw = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const anoRaw = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numeroRaw) return null;

  const match = numeroRaw.match(/^(\d+)\s*\/\s*(\d{2,4})$/);
  const numero = match ? match[1] : numeroRaw;
  const ano = match ? match[2] : anoRaw;
  const numeroInt = parseInt(numero, 10);
  if (!Number.isFinite(numeroInt)) return null;

  return {
    numero,
    numeroInt,
    ano: ano && ano.length === 2 ? '20' + ano : ano,
  };
}


function radar03BlocoEmail(novas) {
  return radar03AgruparNovidades(novas)
    .map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : ''))
    .join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PROJETO LEI': 'PL', 'PROJETO DE LEI ORDINARIA': 'PL', 'PLO': 'PL', 'PL': 'PL', 'PL - PROJETO DE LEI': 'PL', 'PL PROJETO DE LEI': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC', 'PLC - PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC PROJETO DE LEI COMPLEMENTAR': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC', 'PEC - PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC', 'PEC PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'PROJETO DE INDICACAO': 'PIL', 'PIL': 'PIL', 'PIL - PROJETO DE INDICACAO': 'PIL', 'PIL PROJETO DE INDICACAO': 'PIL',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || p?.codigo || p?.projeto_id || p?.id_proposicao || ''),
      ementa: String(p?.ementa || p?.resumo || p?.titulo || '').trim(),
      link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
      clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      clienteCitado: Array.isArray(p?.clientesCitados) && p.clientesCitados.length > 0,
      clienteCitadoNomes: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
    };
    let atual = porTipo.get(tipo);
    if (!atual) {
      atual = { ...itemCaptado, itens: [] };
      porTipo.set(tipo, atual);
    }
    atual.itens.push(itemCaptado);
    if (partes.numeroInt > atual.numeroInt) {
      atual.numeroInt = partes.numeroInt;
      atual.numero = partes.numero;
      atual.ano = partes.ano || String(p?.ano || '');
      atual.id = itemCaptado.id;
      atual.ementa = itemCaptado.ementa;
      atual.link = itemCaptado.link;
      atual.clienteSugestao = itemCaptado.clienteSugestao;
    }
  });
  return Array.from(porTipo.values()).map(rec => {
    rec.itens.sort((a, b) => a.numeroInt - b.numeroInt);
    return rec;
  });
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      const detalhes = rec.itens && rec.itens.length ? rec.itens : [rec];
      const existentesTipo = casa.items.filter(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      const baseAtual = existentesTipo.reduce((max, i) => {
        const n = Number.parseInt(String(i?.base || i?.mon || 0), 10) || 0;
        return Math.max(max, n);
      }, 0);

      detalhes.forEach(det => {
        let item = casa.items.find(i =>
          (det.id && i?.radar03Id === det.id) ||
          (radar03TipoControle(i?.tipo || '') === det.tipo &&
            Number.parseInt(String(i?.mon || 0), 10) === det.numeroInt &&
            String(i?.link || '') === String(det.link || ''))
        );
        if (!item && !(det.id || det.link)) {
          item = casa.items.find(i => radar03TipoControle(i?.tipo || '') === det.tipo);
        }
        if (!item) {
          item = { tipo: det.tipo, base: baseAtual, mon: det.numeroInt, radar03Id: det.id || '' };
          casa.items.push(item);
        }

        const base = Number.parseInt(String(item.base || baseAtual || 0), 10) || 0;
        item.tipo = det.tipo;
        item.mon = det.numeroInt;
        item.delta = det.numeroInt === base ? 0 : 1;
        item.sentido = det.numeroInt === base ? 'bate com o controle' : 'captado individualmente na fonte';
        item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
        item.ementa = det.ementa || item.ementa || '';
        item.link = det.link || item.link || '';
        item.clienteSugestao = det.clienteSugestao || item.clienteSugestao || '';
        item.clienteCitado = Boolean(det.clienteCitado || item.clienteCitado);
        item.clienteCitadoNomes = det.clienteCitadoNomes || item.clienteCitadoNomes || item.clienteSugestao || '';
        item.radar03Id = det.id || item.radar03Id || '';
        item.listaReal03 = true;
      });
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data, merge_casas: [CASA_RADAR03] }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({ casa: CASA_RADAR03, bloco: radar03AgruparNovidades(novas).map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '), fonte: radar03PrimeiraFonte(novas) });
  return `${RADAR03_URL}?${params.toString()}`;
}


function radar03SemNovidadeUrl() {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    situacao: 'sem_novidade',
    fonte: 'monitor-proposicoes',
  });
  return RADAR03_URL + '?' + params.toString();
}

function radar03Escape(valor) {
  return String(valor ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


function renderRadar03SemNovidadeEmailButton() {
  return '\n    <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:12px 14px;margin:14px 0;color:#334155;font-size:13px">\n      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Sem novidades</div>\n      <div style="margin-bottom:9px;color:#475569">' + radar03Escape(CASA_RADAR03) + ' · fonte vista sem proposição nova nesta rodada</div>\n      <a href="' + radar03Escape(radar03SemNovidadeUrl()) + '" style="display:inline-block;background:#475569;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Marcar sem novidade na 03</a>\n      <span style="font-size:12px;color:#64748b;margin-left:8px">abre a 03 pronta para fechar o dia</span>\n    </div>\n  ';
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return renderRadar03SemNovidadeEmailButton();
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(proposicoes) {
  if (CONTROLE03_FORCE_LATEST) {
    console.log('📌 Modo Controle 03: email de novidades não enviado.');
    return;
  }

  anotarClientesCitados(proposicoes);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_REMETENTE,
      pass: process.env.EMAIL_SENHA
    }
  });

  const html = fichaEmailButtonHtml() + renderRadar03EmailButton(proposicoes) + montarEmail(proposicoes);
  const assunto = `🏛️ Minas Gerais: ${proposicoes.length} nova${proposicoes.length > 1 ? 's' : ''} proposiç${proposicoes.length > 1 ? 'ões' : 'ão'} — ${new Date().toLocaleDateString('pt-BR')}`;

  await transporter.sendMail({
    from: process.env.EMAIL_REMETENTE,
    to: process.env.EMAIL_DESTINO,
    subject: assuntoEmailClienteCitado(proposicoes, assunto),
    html
  });

  console.log(`Email enviado: "${assunto}"`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Monitor ALMG — ${new Date().toISOString()} ===`);

  const estado = carregarEstado();
  console.log(`Estado carregado: ${estado.proposicoes_vistas.length} proposições conhecidas`);

  const novas = await buscarProposicoesNovas(CONTROLE03_FORCE_LATEST ? [] : estado.proposicoes_vistas);
  console.log(`Novas proposições encontradas: ${novas.length}`);

  if (CONTROLE03_FORCE_LATEST) {
    await sincronizarRadar03(novas.slice(0, 120));
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    console.log('✅ Radar 03 atualizado fora de hora com a lista atual da fonte. Email não enviado.');
    return;
  }

  if (novas.length > 0) {
    await sincronizarRadar03(novas);
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
