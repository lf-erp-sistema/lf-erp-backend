-- Migration 045 — Catálogo de Serviços (OS)
-- Serviços globais (empresa_id NULL) disponíveis para todas as empresas

CREATE TABLE IF NOT EXISTS servicos_catalogo (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  categoria   TEXT NOT NULL,
  nome        TEXT NOT NULL,
  valor_padrao NUMERIC(12,2) DEFAULT 0,
  ativo       BOOLEAN DEFAULT TRUE,
  criado_em   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_svc_empresa_id ON servicos_catalogo(empresa_id);
CREATE INDEX IF NOT EXISTS idx_svc_categoria  ON servicos_catalogo(categoria);
CREATE INDEX IF NOT EXISTS idx_svc_ativo      ON servicos_catalogo(ativo);

-- ─── Seed: Catálogo global (empresa_id = NULL) ────────────────────────────────
INSERT INTO servicos_catalogo (empresa_id, categoria, nome) VALUES

-- Celular • Tela e Display
(NULL, 'Celular • Tela', 'Troca de tela completa (display + touch)'),
(NULL, 'Celular • Tela', 'Troca de vidro frontal com digitizer'),
(NULL, 'Celular • Tela', 'Troca de tela OLED'),
(NULL, 'Celular • Tela', 'Troca de tela AMOLED'),
(NULL, 'Celular • Tela', 'Troca de tela LCD'),
(NULL, 'Celular • Tela', 'Troca de moldura / frame da tela'),
(NULL, 'Celular • Tela', 'Reparo de tela com manchas ou listras'),
(NULL, 'Celular • Tela', 'Reparo de tela sem brilho / apagada'),

-- Celular • Bateria e Energia
(NULL, 'Celular • Bateria', 'Troca de bateria'),
(NULL, 'Celular • Bateria', 'Troca de conector de carga USB-C'),
(NULL, 'Celular • Bateria', 'Troca de conector de carga Lightning'),
(NULL, 'Celular • Bateria', 'Troca de conector de carga Micro-USB'),
(NULL, 'Celular • Bateria', 'Troca de flex de carregamento'),
(NULL, 'Celular • Bateria', 'Troca de CI de carregamento (microssoldagem)'),
(NULL, 'Celular • Bateria', 'Reparo de carregamento sem fio (wireless)'),
(NULL, 'Celular • Bateria', 'Reparo de celular que não liga'),
(NULL, 'Celular • Bateria', 'Reparo de celular que não carrega'),

-- Celular • Câmera
(NULL, 'Celular • Câmera', 'Troca de câmera traseira simples'),
(NULL, 'Celular • Câmera', 'Troca de câmera traseira dupla'),
(NULL, 'Celular • Câmera', 'Troca de câmera traseira tripla'),
(NULL, 'Celular • Câmera', 'Troca de câmera frontal (selfie)'),
(NULL, 'Celular • Câmera', 'Reparo de câmera sem foco'),
(NULL, 'Celular • Câmera', 'Reparo de câmera embaçada'),
(NULL, 'Celular • Câmera', 'Troca de lente de vidro da câmera'),

-- Celular • Áudio
(NULL, 'Celular • Áudio', 'Troca de alto-falante principal (buzzer)'),
(NULL, 'Celular • Áudio', 'Troca de alto-falante auricular (chamadas)'),
(NULL, 'Celular • Áudio', 'Troca de microfone'),
(NULL, 'Celular • Áudio', 'Reparo de áudio sem saída de som'),
(NULL, 'Celular • Áudio', 'Troca de CI de áudio (microssoldagem)'),

-- Celular • Carcaça e Estrutura
(NULL, 'Celular • Carcaça', 'Troca de carcaça / chassi lateral'),
(NULL, 'Celular • Carcaça', 'Troca de tampa traseira de vidro'),
(NULL, 'Celular • Carcaça', 'Troca de tampa traseira plástica'),
(NULL, 'Celular • Carcaça', 'Troca de botão power'),
(NULL, 'Celular • Carcaça', 'Troca de botão volume'),
(NULL, 'Celular • Carcaça', 'Troca de botão home'),
(NULL, 'Celular • Carcaça', 'Troca de leitor de impressão digital'),
(NULL, 'Celular • Carcaça', 'Troca / reparo de sensor Face ID'),
(NULL, 'Celular • Carcaça', 'Troca de vibrador'),

-- Celular • Conectividade
(NULL, 'Celular • Conectividade', 'Troca de antena de sinal GSM / 4G / 5G'),
(NULL, 'Celular • Conectividade', 'Troca de antena Wi-Fi / Bluetooth'),
(NULL, 'Celular • Conectividade', 'Troca de bandeja SIM card'),
(NULL, 'Celular • Conectividade', 'Reparo de leitor SIM card'),
(NULL, 'Celular • Conectividade', 'Reparo de sinal de rede fraco ou ausente'),
(NULL, 'Celular • Conectividade', 'Reparo de Wi-Fi sem conexão'),

-- Celular • Software e Dados
(NULL, 'Celular • Software', 'Formatação e restauração de fábrica'),
(NULL, 'Celular • Software', 'Desbloqueio de senha / PIN / padrão'),
(NULL, 'Celular • Software', 'Desbloqueio de Face ID'),
(NULL, 'Celular • Software', 'Desbloqueio de iCloud / Activation Lock'),
(NULL, 'Celular • Software', 'Desbloqueio de operadora / IMEI'),
(NULL, 'Celular • Software', 'Atualização de firmware / sistema operacional'),
(NULL, 'Celular • Software', 'Transferência de dados e backup'),
(NULL, 'Celular • Software', 'Recuperação de dados excluídos'),
(NULL, 'Celular • Software', 'Remoção de vírus / malware'),

-- Celular • Dano por Líquido
(NULL, 'Celular • Líquido', 'Limpeza e recuperação por dano de líquido'),
(NULL, 'Celular • Líquido', 'Limpeza de conector de carga'),
(NULL, 'Celular • Líquido', 'Limpeza interna de poeira e oxidação'),
(NULL, 'Celular • Líquido', 'Reparo de placa-mãe — reballing / microssoldagem'),

-- Notebook • Tela e Vídeo
(NULL, 'Notebook • Tela', 'Troca de tela LED'),
(NULL, 'Notebook • Tela', 'Troca de tela IPS'),
(NULL, 'Notebook • Tela', 'Troca de tela OLED'),
(NULL, 'Notebook • Tela', 'Troca de tela 4K'),
(NULL, 'Notebook • Tela', 'Troca de cabo flat / cabo de vídeo'),
(NULL, 'Notebook • Tela', 'Troca de placa de vídeo (GPU dedicada)'),
(NULL, 'Notebook • Tela', 'Reparo de tela piscando ou com linhas'),
(NULL, 'Notebook • Tela', 'Reparo de tela apagada / sem imagem'),

-- Notebook • Armazenamento e Memória
(NULL, 'Notebook • Armazenamento', 'Troca de HD por SSD SATA'),
(NULL, 'Notebook • Armazenamento', 'Instalação de SSD NVMe / M.2'),
(NULL, 'Notebook • Armazenamento', 'Upgrade de memória RAM'),
(NULL, 'Notebook • Armazenamento', 'Recuperação de dados de HD com defeito'),
(NULL, 'Notebook • Armazenamento', 'Recuperação de dados de SSD com defeito'),
(NULL, 'Notebook • Armazenamento', 'Clonagem de HD para SSD'),

-- Notebook • Bateria e Energia
(NULL, 'Notebook • Bateria', 'Troca de bateria'),
(NULL, 'Notebook • Bateria', 'Troca / reparo de conector de carga DC'),
(NULL, 'Notebook • Bateria', 'Troca de placa de alimentação'),
(NULL, 'Notebook • Bateria', 'Reparo de notebook que não liga'),
(NULL, 'Notebook • Bateria', 'Reparo de notebook que não carrega'),

-- Notebook • Resfriamento e Desempenho
(NULL, 'Notebook • Cooling', 'Limpeza interna completa (cooler + dissipador)'),
(NULL, 'Notebook • Cooling', 'Troca de pasta térmica (CPU / GPU)'),
(NULL, 'Notebook • Cooling', 'Troca de cooler / ventoinha'),
(NULL, 'Notebook • Cooling', 'Reparo de superaquecimento'),

-- Notebook • Teclado e Periféricos
(NULL, 'Notebook • Teclado', 'Troca de teclado completo'),
(NULL, 'Notebook • Teclado', 'Troca de teclas avulsas'),
(NULL, 'Notebook • Teclado', 'Troca de touchpad / trackpad'),
(NULL, 'Notebook • Teclado', 'Troca de webcam'),
(NULL, 'Notebook • Teclado', 'Troca de placa Wi-Fi / Bluetooth'),
(NULL, 'Notebook • Teclado', 'Reparo de portas USB / HDMI / Thunderbolt'),

-- Notebook • Estrutura
(NULL, 'Notebook • Estrutura', 'Troca / reparo de dobradiça da tampa'),
(NULL, 'Notebook • Estrutura', 'Troca de carcaça superior (palmrest)'),
(NULL, 'Notebook • Estrutura', 'Troca de carcaça inferior (base)'),
(NULL, 'Notebook • Estrutura', 'Troca de carcaça da tampa'),

-- Notebook • Placa-mãe e Avançado
(NULL, 'Notebook • Placa', 'Troca de placa-mãe'),
(NULL, 'Notebook • Placa', 'Reparo de placa-mãe — microssoldagem'),
(NULL, 'Notebook • Placa', 'Reparo de placa com curto'),
(NULL, 'Notebook • Placa', 'Recuperação por dano de líquido'),
(NULL, 'Notebook • Placa', 'Atualização de BIOS / drivers'),
(NULL, 'Notebook • Placa', 'Troca de leitor de cartão SD'),

-- Notebook • Software
(NULL, 'Notebook • Software', 'Formatação e instalação do Windows'),
(NULL, 'Notebook • Software', 'Formatação e instalação do Linux'),
(NULL, 'Notebook • Software', 'Formatação e instalação do macOS'),
(NULL, 'Notebook • Software', 'Remoção de vírus / ransomware / malware'),
(NULL, 'Notebook • Software', 'Otimização de desempenho'),
(NULL, 'Notebook • Software', 'Instalação de programas e drivers'),
(NULL, 'Notebook • Software', 'Recuperação de sistema sem formatar'),
(NULL, 'Notebook • Software', 'Atualização de sistema operacional'),

-- Tablet
(NULL, 'Tablet', 'Troca de tela / vidro'),
(NULL, 'Tablet', 'Troca de bateria'),
(NULL, 'Tablet', 'Troca de conector de carga'),
(NULL, 'Tablet', 'Troca de câmera'),
(NULL, 'Tablet', 'Troca de botões e carcaça'),
(NULL, 'Tablet', 'Reparo por dano de líquido'),
(NULL, 'Tablet', 'Formatação e restauração'),
(NULL, 'Tablet', 'Desbloqueio de senha / iCloud'),

-- Smartwatch
(NULL, 'Smartwatch', 'Troca de tela / vidro frontal'),
(NULL, 'Smartwatch', 'Troca de bateria'),
(NULL, 'Smartwatch', 'Troca de coroa / botões'),
(NULL, 'Smartwatch', 'Reparo por dano de líquido'),
(NULL, 'Smartwatch', 'Troca de carcaça / back cover'),

-- Geral
(NULL, 'Geral', 'Diagnóstico técnico'),
(NULL, 'Geral', 'Mão de obra — serviço geral'),
(NULL, 'Geral', 'Orçamento e avaliação'),
(NULL, 'Geral', 'Higienização e limpeza externa');
