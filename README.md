# FAST - North Police Auto Timesheet

Aplicativo de bandeja para abrir e fechar automaticamente o ponto no Discord conforme o estado de serviço no FiveM da Metrópole.

## Integrações configuradas

- Servidor Discord: `1197567547936079922`
- Canal do ponto: `1222646689203097772`
- Botões: `Abrir Ponto` e `Fechar Ponto`
- Corporações reconhecidas: `Polícia Norte`, `Polícia do Norte`, `Polícia Militar Norte`, `Polícia Militar do Norte` e `North Police`
- Atualizações: releases de `aledsst-ai/fast-resources`

## Desenvolvimento

```powershell
npm install
npm test
npm run build
```

O instalador é gerado em `dist/`.

## Publicação de atualização

Crie uma release com a tag correspondente à versão (por exemplo, `v1.0.7`) em
`aledsst-ai/fast-resources` e anexe os três arquivos gerados em `dist/`:

- `mtp-auto-timesheet-setup-1.0.7.exe`
- `mtp-auto-timesheet-setup-1.0.7.exe.blockmap`
- `latest.yml`

O aplicativo consulta esses arquivos automaticamente pelo `electron-updater`.
