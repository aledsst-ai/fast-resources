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

Crie uma release com a tag correspondente à versão (por exemplo, `v1.1.2`) em
`aledsst-ai/fast-resources` e anexe os três arquivos gerados em `dist/`:

- `mtp-auto-timesheet-setup-1.1.2.exe`
- `mtp-auto-timesheet-setup-1.1.2.exe.blockmap`
- `latest.yml`

O aplicativo consulta esses arquivos automaticamente pelo `electron-updater`.

## Alterações da versão 1.1.2

- Captura o clique de entrar ou sair de serviço antes de o tablet fechar.
- Mantém separado o token da `gameapi`, evitando substituição por tokens do telefone.
- Confirma transições por observação visual, resposta de rede e consultas rápidas à API.
- Serializa as ações do Discord para não perder uma saída durante a abertura do ponto.
- Reconhece quando o Discord já está no estado desejado e evita cliques duplicados.
