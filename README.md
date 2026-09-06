# FAST - North Police Auto Timesheet

Aplicativo de bandeja para abrir e fechar automaticamente o ponto no Discord conforme o estado de serviço no FiveM da Metrópole.

Também incorpora o Auxiliar de Anúncios da FAST: ao copiar uma sequência preparada
pelo Gerador de Anúncios, cada `Ctrl+V` cola o próximo campo no FiveM. O atalho
só é interceptado enquanto existe uma sequência ativa.

## Integrações configuradas

- Servidor Discord: `1197567547936079922`
- Canal do ponto: `1222646689203097772`
- Botões: `Abrir Ponto` e `Fechar Ponto`
- Corporações reconhecidas: `Polícia Norte`, `Polícia do Norte`, `Polícia Militar Norte`, `Polícia Militar do Norte` e `North Police`
- Atualizações: releases de `aledsst-ai/fast-resources`
- Auxiliar de Anúncios: compatível com o payload `FAST_ANNOUNCEMENT_QUEUE_V1`

O auxiliar integrado é ativado por padrão e aparece no menu do mesmo ícone de
bandeja do bate-ponto. Pelo menu é possível desativá-lo ou cancelar a sequência.
Seus avisos ficam somente no computador e não são enviados ao celular do FiveM.

Se a versão separada do FAST Race Assistant estiver aberta, a integrada não
inicia para evitar dois interceptadores de teclado simultâneos. Encerre a versão
separada e reinicie este aplicativo.

## Desenvolvimento

```powershell
npm install
npm test
npm run build
```

O instalador é gerado em `dist/`.

## Publicação de atualização

Crie uma release com a tag correspondente à versão (por exemplo, `v1.1.5`) em
`aledsst-ai/fast-resources` e anexe os três arquivos gerados em `dist/`:

- `mtp-auto-timesheet-setup-1.1.5.exe`
- `mtp-auto-timesheet-setup-1.1.5.exe.blockmap`
- `latest.yml`

O aplicativo consulta esses arquivos automaticamente pelo `electron-updater`.

## Vinculação ao Dashboard FAST

A partir da versão 1.1.9, o menu da bandeja contém **Vincular ao Dashboard
FAST**. A opção gera um código de oito caracteres, válido por dez minutos, que o
membro confirma em **Dashboard > Ferramentas** com sua conta do Discord.

Depois da vinculação, o aplicativo informa sua versão e a data da última
comunicação ao iniciar, em cada registro de ponto e uma vez por dia enquanto
estiver aberto. Falhas de rede nessa comunicação não interrompem o bate-ponto.

## Alterações da versão 1.1.2

- Captura o clique de entrar ou sair de serviço antes de o tablet fechar.
- Mantém separado o token da `gameapi`, evitando substituição por tokens do telefone.
- Confirma transições por observação visual, resposta de rede e consultas rápidas à API.
- Serializa as ações do Discord para não perder uma saída durante a abertura do ponto.

## Correção da versão 1.1.3

- Remove a inferência baseada no botão oposto do Discord, que podia considerar o
  ponto aberto sem clicar em **Abrir Ponto**.
- Mantém a captura instantânea da ação no tablet introduzida na versão 1.1.2.

## Correção da versão 1.1.4

- Restringe a automação ao clique nos controles **Entrar em Serviço** e
  **Sair de Serviço**.
- Ignora cliques no menu lateral e em outros elementos cujo contêiner também
  inclua o texto do botão de serviço.

## Correção da versão 1.1.5

- Valida novamente no processo principal se o evento veio exatamente dos
  controles **Entrar em Serviço** ou **Sair de Serviço**.
- Bloqueia eventos amplos enviados por listeners antigos que continuaram vivos
  no FiveM durante uma atualização automática.
- Reinstala o observer atual quando encontra o marcador de uma versão anterior.
