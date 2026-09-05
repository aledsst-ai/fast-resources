# FAST - North Police Auto Timesheet

Aplicativo de bandeja para abrir e fechar automaticamente o ponto no Discord conforme o estado de serviço no FiveM da Metrópole.

Também incorpora o Auxiliar Ctrl+V da FAST: ao copiar uma sequência preparada
pelo Gerador de Anúncios, cada `Ctrl+V` cola o próximo campo no FiveM. O atalho
só é interceptado enquanto existe uma sequência ativa.

## Integrações configuradas

- Servidor Discord: `1197567547936079922`
- Canal do ponto: `1222646689203097772`
- Botões: `Abrir Ponto` e `Fechar Ponto`
- Corporações reconhecidas: `Polícia Norte`, `Polícia do Norte`, `Polícia Militar Norte`, `Polícia Militar do Norte` e `North Police`
- Atualizações: releases de `aledsst-ai/fast-resources`
- Auxiliar Ctrl+V: compatível com o payload `FAST_ANNOUNCEMENT_QUEUE_V1`

O auxiliar integrado é ativado por padrão e aparece no menu do mesmo ícone de
bandeja do bate-ponto. Pelo menu é possível desativá-lo ou cancelar a sequência.

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

Crie uma release com a tag correspondente à versão (por exemplo, `v1.1.0`) em
`aledsst-ai/fast-resources` e anexe os três arquivos gerados em `dist/`:

- `mtp-auto-timesheet-setup-1.1.0.exe`
- `mtp-auto-timesheet-setup-1.1.0.exe.blockmap`
- `latest.yml`

O aplicativo consulta esses arquivos automaticamente pelo `electron-updater`.
