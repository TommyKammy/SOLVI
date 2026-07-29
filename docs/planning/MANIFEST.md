---
project: SOLVI
doc_id: "ROOT-MANIFEST"
title: "SOLVI Vault Manifest"
category: "ROOT"
type: "manifest"
status: "accepted"
version: "0.7.0"
created: "2026-07-27"
updated: "2026-07-28"
owner: "SOLVI Product Team"
tags: ["manifest"]
source_of_truth: true
implementation_status: "not-started"
---

# SOLVI Vault Manifest

## 対象範囲

- **対象**: 本Vault直下のすべてのファイル(Markdown・画像・SVG)。`assets/`配下を含む。
- **対象外**: `MANIFEST.md`自身、`.git/`、`.claude/`(ツールのローカル設定)、`.DS_Store`。
- **配布時**: 対象外のものはZIP/リポジトリへ含めない。

## 再生成の手順

Vault直下で以下を実行し、本ファイルの表を置き換える(パス順にソートすること)。

```bash
find . -type f ! -path './.git/*' ! -path './.claude/*' ! -name '.DS_Store' ! -name 'MANIFEST.md' -print0 \
  | sort -z | xargs -0 shasum -a 256
```

ファイルを変更した場合は、必ず本ファイルを再生成する。差分が出たまま配布・引き渡しをしない。

## 集計

| 項目 | 値 |
|---|---:|
| 対象ファイル | 259 |
| Markdown | 251 |
| 画像・SVG | 8 |
| 合計サイズ | 6,778,633 bytes |

## ファイル一覧

| Path | Size | SHA-256 |
|---|---:|---|
| `00_Index/00.1_Start_Here.md` | 2135 | `3b6aa02f793dcb72923b8ebd74a4c9670c086c6da325743b22a989b676ed1d22` |
| `00_Index/00.2_Reading_Order.md` | 2205 | `693dbdf2d0625f968bbe8a2fb2931644ed8aa43cef67bce6f1b6b1726581972d` |
| `00_Index/00.3_Project_Map.md` | 11547 | `0150316d80a88f8ea6a902e0b34b1a58d53976471dd6531ff05d8632cf1e18e1` |
| `00_Index/00.4_Document_Governance.md` | 1008 | `2fbfc21bb99babdde34ee026cd415d5ed7926ce26fed090ad9d99f410d24da6f` |
| `00_Index/00.5_Glossary.md` | 7544 | `119ef942acc5453c1961397877f89ab944e0fda2719143119052c195fd6b7e44` |
| `00_Index/00.6_Decision_Register.md` | 2302 | `80fc2fe9a2180726c9aae276dea658592c6c7f930b51707690b931fb826db226` |
| `00_Index/00.7_Open_Questions.md` | 3943 | `50ccdac4badf60bc06e335d5db3e66d757f987b14d6cd7dfbaf300262fcabc9a` |
| `00_Index/00.8_Status_Dashboard.md` | 6921 | `9dcb24900173abd77ce6a4c20929c5df6165d72312990a5141c29425f5df4c18` |
| `01_Product/01.10_Naming_and_Brand.md` | 1742 | `37275c6a29c345ce554a6fa49711181a228a707234e66b932abaac4cc3c40cc7` |
| `01_Product/01.1_Product_Vision.md` | 1887 | `d4655af6eb4aa4b9526fe08fce5415cc23e145fa75799adced322fe6d5d9e2ce` |
| `01_Product/01.2_Problem_Statement.md` | 1835 | `03d33a4087989fe7decebd1dcdf2f94fb2c5b10f80b1d96ac02a320115d4d217` |
| `01_Product/01.3_Product_Principles.md` | 1739 | `9cc748d5f53cc98b0e07f5b90d6adc1c59be476eed5fa8376049c647c732c8c8` |
| `01_Product/01.4_Target_Users_and_Personas.md` | 1842 | `ecaefe7df451998a587c7cbb7e9589e2e274571af639c08607cc1638579df97d` |
| `01_Product/01.5_Scope_and_Non_Goals.md` | 4363 | `a75016e89f3b6fdbd5780050c0967e3a3410572af4bd018333b4cc5a985a6dc6` |
| `01_Product/01.6_Service_Model.md` | 1754 | `8f9953339a49717094ab3c04ee908acc604ff46ebbe5555cd08636c35e14329a` |
| `01_Product/01.7_Value_Proposition.md` | 1799 | `ffc789fcd6b4e41664ae1330293649ecb9ca9cbeb662888c2eece5419895f98e` |
| `01_Product/01.8_Success_Metrics.md` | 2493 | `16ce44d1b4eaa70113ba25211b96fdf6ffe4656a491e7add4daceee771a50bd1` |
| `01_Product/01.9_Adoption_and_Change.md` | 1731 | `8027f5cd1295cc1afc2141e548b212e6b52346f5c9eafe3ac701e76e832c0b57` |
| `02_Architecture/02.10_Workflow_and_Outbox.md` | 1647 | `4869098b94a38aaec298cb8eb304e155c4aa0042677d8f810745243818a43933` |
| `02_Architecture/02.11_Integration_Architecture.md` | 1642 | `37be2d10be55758e9836fcc89b55c19f9bef86acf67b864bd284869a04b4d5be` |
| `02_Architecture/02.12_Deployment_Architecture.md` | 1651 | `77f0812b315a9d436616f638577f346b720b9842b87abaf80823d77c62b1417d` |
| `02_Architecture/02.13_Observability.md` | 3865 | `42e3c9c0505ee6044be2f1d29e51b779d862b2c1c73a4b13a5363ad93b4cd237` |
| `02_Architecture/02.14_Threat_Model.md` | 7835 | `fc68f41bd24db2c6e24ffa723a8a24f716d0670d25fb6085fa69652a653d01eb` |
| `02_Architecture/02.15_Backup_DR_and_Continuity.md` | 1603 | `5565e28769667b59f66de344a0f6343d7ad7f84c0efd42a2a5a04fa8bf61a000` |
| `02_Architecture/02.16_Executor_Command_Contract.md` | 7323 | `01cdede8fe573c599ae9b3a521e1b02242a639d2ed7af2a697cc02232ea7255c` |
| `02_Architecture/02.17_Audit_Event_Catalog.md` | 6403 | `5a41cc17f8290d0eab937115cf4a31810dc209ff915d4e33aab294ebbed80c75` |
| `02_Architecture/02.18_Organization_Data_Model_and_RLS.md` | 16157 | `d7dbddab060a287a42005a437eb0fe2b80216f56ed1ac65c7c7c2006b7c4e0e2` |
| `02_Architecture/02.1_Architecture_Overview.md` | 6829 | `9a657b74dcc84bdec5987c2fa81b279f4d19d602dfc2a6b216e1e6074cbf73ce` |
| `02_Architecture/02.2_System_Context.md` | 1618 | `dee50b22a0410b93302a4cd272bdb41c7961c9bb648c9929c957179ecce363de` |
| `02_Architecture/02.3_Container_Architecture.md` | 1652 | `c03baed27fa14a3e4c1ae86c046407d23a349501dab4a0d6efd7ccd809570fe5` |
| `02_Architecture/02.4_Domain_Architecture.md` | 1635 | `e8d5dee8fa819de259397e0d3a635c5dca9c6b9188d0fcba204d4281a68b21e7` |
| `02_Architecture/02.5_Data_Architecture.md` | 1627 | `38b73a3fc64b1fc3039f087759a8f770ce96ec6b3204f70df2a7074eb1501f9b` |
| `02_Architecture/02.6_Security_Architecture.md` | 1658 | `73ad04d20bcec6b8cac68100a843041a843152200333c399143b1ad6a9f783be` |
| `02_Architecture/02.7_Executor_Boundary.md` | 1630 | `d5f36e6349d95b27a3706c90189b731d42f82906e10dffaa36f0200d3e8bff3b` |
| `02_Architecture/02.8_AI_Architecture.md` | 1675 | `0e0a6d624fc5ed72a52773759a6cc6d8815eea030bf48e63d06d1e330fca8b7c` |
| `02_Architecture/02.9_Identity_and_Access.md` | 1633 | `ec02c30e563358484301bb45567cd7a5b0a5ed6475b23976e0e51735f68e238a` |
| `03_Requirements/03.10_AI_Requirements.md` | 1779 | `762002d89f9f4b18233d15eb7f26a317f647f34bcfc7f317c650c840b48bcb70` |
| `03_Requirements/03.11_Security_Requirements.md` | 2939 | `5c88f65941efec01b7ebaa8caf473d80e724bf7361aa6529bfef9b48d9c0508d` |
| `03_Requirements/03.12_Operations_Performance_Requirements.md` | 2095 | `97f889ca2b536d80e953cf7bbb345e591ec3eebb8f2dc4d19dae36cb0b2a1a57` |
| `03_Requirements/03.13_UX_Accessibility_Requirements.md` | 2275 | `685950372dea8b86dd8ca309797b115ba1a4931d7c6c82ad8a859319ec26e818` |
| `03_Requirements/03.14_Maintainability_Requirements.md` | 1139 | `7dbd0248be421b2bf3acf1cf4eeb532e109be9b17d3bdd09554c2e6c70fe3e94` |
| `03_Requirements/03.15_Use_Case_Catalog.md` | 1827 | `f1f3713d6d7a5b70953c7f1a9ac690e525e6294842c452d9963b9891be26b201` |
| `03_Requirements/03.16_Data_Retention_and_Privacy.md` | 1335 | `7ab46cbb49782b6d5dcbc7ba8838cd160f1964a9e161a795ebefbd59c1877c9a` |
| `03_Requirements/03.17_Acceptance_Test_Strategy.md` | 1346 | `1c59e4736e0efe22888f0f530a0ec8fe08b319faba2a6a991dba92bc65f9247b` |
| `03_Requirements/03.18_Requirements_Traceability_Matrix.md` | 13835 | `69bf2bf38607c63aec6c8764bfbb52857417bf4f6c62ef352a4b6b61a338faca` |
| `03_Requirements/03.19_Migration_and_Audit_Requirements.md` | 3105 | `90e5bd7b75a0138a879ac6865beca5f1337eeb0035bde4ed18a56e1260e3ac8d` |
| `03_Requirements/03.1_Requirements_Baseline.md` | 11638 | `be482a5ea556299884b2f18305aac5cd5b45efcb81df0ecb7d67345ef80d531d` |
| `03_Requirements/03.2_Business_and_Stakeholder_Requirements.md` | 1756 | `05b10fcccb01750d9ee3457a532acd74a1534cc7b763e7ea8f042683da4f532e` |
| `03_Requirements/03.3_Ticket_Requirements.md` | 4016 | `cffb8db0c2afb7a6fde461eb2672770a0dd904ebbb20a631e82e608e0c0214d9` |
| `03_Requirements/03.4_Knowledge_Requirements.md` | 1491 | `9f68149899ef431520a20b008cc8cd7f8290d3b1f1c01fbd23ce807dfbffd159` |
| `03_Requirements/03.5_Catalog_and_Approval_Requirements.md` | 3868 | `ae282818477298a5a9843875da65ca81421719133075916299e9089a6ad7fbf4` |
| `03_Requirements/03.6_Automation_Executor_Requirements.md` | 2255 | `c32de4903cc93841dc0c46111dbf9d3c00e668411a60176c1daa811ec2ecb1a2` |
| `03_Requirements/03.7_Identity_OIDC_SCIM_Requirements.md` | 3947 | `b689df8e1697c1d6a8b21caa9ce433fd9be23df3a9d8081df0b9bb25db19c7d4` |
| `03_Requirements/03.8_Asset_CMDB_Requirements.md` | 1528 | `75d6ffc4f7325b36c333e730110fa600935839d7a889b03026b1e70e25aba791` |
| `03_Requirements/03.9_Change_Management_Requirements.md` | 1530 | `5edbd6ba0e3cec3ed29f9d8681216b0f6a7b8a0fca2c931f7128f7fc6bcb7ef4` |
| `04_Development/04.10_Phase_8_Plan.md` | 1932 | `075907524c388bf66ef1df78101936c3aa65fae37cc9090c28075bc444966669` |
| `04_Development/04.11_Phase_9_Plan.md` | 1959 | `6e2b2b06b4c5a3ca9280b9fae8206e95a755541194576d434a62b3b9a0132c0c` |
| `04_Development/04.12_Environment_Strategy.md` | 1549 | `3ac575252acf0ee22d08255ff19459cbc67783ab32a765ccb8b6cc3a2e1ddb6b` |
| `04_Development/04.13_Branch_PR_Strategy.md` | 1498 | `ab023a3c62366039f029dc29a79fb07d68a03d2a052915fe8d308738ded2c44b` |
| `04_Development/04.14_CI_CD_Quality_Gates.md` | 1551 | `8c73f42fcbd8544dc65691256315fcaacd8793c8f5d8c8b26542fb04a50b11b1` |
| `04_Development/04.15_Release_and_Operations_Strategy.md` | 1557 | `304a732892421abe94d100a53680a2c7659d3b320c26080b5d9c8acc4a98ed3e` |
| `04_Development/04.16_Test_Strategy.md` | 3575 | `fda4da02e3358d0c773871e324113748d3d20734fd94341b41dcea3491094806` |
| `04_Development/04.17_Secure_Development_Lifecycle.md` | 1580 | `1df4682b7d7c9dab9f48b6115aaf3945ea8347283e46dc4adc1fe9c7638a760e` |
| `04_Development/04.18_Codex_Operating_Model.md` | 1601 | `e219fb36a4ab0a5fce3bc1460e008c69adabefba432c120c77f4d7681368af69` |
| `04_Development/04.19_Definition_of_Ready_and_Done.md` | 4534 | `3e51b3f196b4f32718b9626b4aa35f6dc4ca5e9a0e54b17fcab9d0a360723536` |
| `04_Development/04.1_Master_Roadmap.md` | 3886 | `0f9611246b70c4ff1f79a9b9a463dea4c4e42f17ee76442be53df688938098e9` |
| `04_Development/04.20_Migration_and_Cutover_Strategy.md` | 1587 | `da894bc0cbeceb9c402d1c46b06b23b11bdb9118e3e7e446ef7ff97848c181d6` |
| `04_Development/04.21_Pilot_Strategy.md` | 1476 | `401de887efff0d14af0ca603f3a9a0c1ec104390a9f02118a247faac675718db` |
| `04_Development/04.22_Gate_Definitions.md` | 13372 | `c3bbc3684d41a4ee859bc51dc34dbe66eac01b1cc8b249d21f340a461af7dc92` |
| `04_Development/04.23_Wiring_Verification.md` | 10386 | `2e0eeb334d0cc3f49411eb2ebd69db12dee17d0d8214d53fec20d668fea18b23` |
| `04_Development/04.2_Phase_0_Plan.md` | 2082 | `ebab14277498a5772b299b3e80ad7e74f4d7ce405bc88fa816603e46e9372ca3` |
| `04_Development/04.3_Phase_1_Plan.md` | 2074 | `c02bda42dbde824b9bb8a15cc1ef8da1367e6da11112512263965cde85f5bd9f` |
| `04_Development/04.4_Phase_2_Plan.md` | 2051 | `02ae7575f195c5eede36bbfd8483d364687d1245dac1fa67e2daa18a75f3ddd1` |
| `04_Development/04.5_Phase_3_Plan.md` | 1948 | `4796dd7f9111281757683d3a7bdcd5d5d7e0b4b21a9f00fd382cb5aced1d1172` |
| `04_Development/04.6_Phase_4_Plan.md` | 2243 | `e09909e55ec3b1f5a124cddc5244d97dbeded1d82113920300bd1c2d414e81c5` |
| `04_Development/04.7_Phase_5_Plan.md` | 1894 | `1ecf1c9d4480e6cb8b41ba4fedc490ebcea36b4b56107bf6f42048454bbf7d45` |
| `04_Development/04.8_Phase_6_Plan.md` | 1900 | `520b69d8c2c2e1a91e9b6c59b4e0aa1abbaf3c391640c1c593fb7423624dfda4` |
| `04_Development/04.9_Phase_7_Plan.md` | 1834 | `7f64bda8551819d07aa58e5f705661b186ed43b45d37f4bc54b2f2bafd7898b2` |
| `05_Modules/05.10_Entra_Graph_Connector.md` | 1606 | `e0fc429170ee8c1003f83a290962e6f28b899bbd434bac5141a0f7f73251d674` |
| `05_Modules/05.11_SCIM_Service_Provider.md` | 1607 | `3cd27cb0aede2239f88ff0ebe10cfda4ef86df970f46a184ee69a0bcb2012fc8` |
| `05_Modules/05.12_Asset_CMDB_Lite.md` | 1628 | `ec0598fa42d5ffdcd8c6d1a83390b739a32ed84b9aeb9a4b0fd57d6ece51f691` |
| `05_Modules/05.13_Change_Management.md` | 1592 | `d7492f122b8fc319f51f4579c8a4f4bc29a7dd1da7a55eb35f77d4f5fb46e337` |
| `05_Modules/05.14_SOLVI_Assist.md` | 1601 | `b6b895fa5dfe282c4fd76eec6066a047c86b94dc5ee5c4b60d8dc167aa88ffd7` |
| `05_Modules/05.15_Notification.md` | 1584 | `3f4142f63b0a532598b37c07729dee5d11e56cf56fd8722f1d6c969db50ef435` |
| `05_Modules/05.16_Audit_and_Evidence.md` | 1631 | `0df63639d592455574964a870e9cfc5df6ef00008c42b3a4c22bd3f089e30f94` |
| `05_Modules/05.17_Search.md` | 1572 | `4426f11e3692a95f42aad5f9228cd572c896787657e6a1d74f3174532e935202` |
| `05_Modules/05.18_Admin_Settings.md` | 1608 | `ac842b4627d6f586d6c422379bd16fe77442c077ab3f44acaab11b5d16c85b9b` |
| `05_Modules/05.1_SOLVI_Portal.md` | 1629 | `9a7c435e099bf3473f55167d113ccec96709bda826c8518aad23f2c266690104` |
| `05_Modules/05.2_SOLVI_Ops.md` | 1598 | `8c9121079c17101e581b50ff232487ba671c5e264c164ad737bbf2e1a049ac72` |
| `05_Modules/05.3_Ticket_Core.md` | 1587 | `fcda21c75472c04e364ae8ca4a7dc1e612536ef3dfe70843d71da7229e196b3c` |
| `05_Modules/05.4_Knowledge_Management.md` | 1607 | `23a227ebcdf38acf30e8157ab77ab88bcc36b76e3f060aaa7ded2151dbfbdab4` |
| `05_Modules/05.5_Service_Catalog.md` | 1599 | `6af7dba2812d252243b3d02d36d6608b02648c39c69d94752f5e26f1f80deb3c` |
| `05_Modules/05.6_Approval.md` | 1536 | `c28f18102afb1a3d89d365b5ba679c645f3b054325f871845400a97b13d7ac71` |
| `05_Modules/05.7_Workflow_Orchestration.md` | 1630 | `dda2b5c4c78f8ab737dfb97dcfa58962e3f20a15a86450a188586e275a431404` |
| `05_Modules/05.8_SOLVI_Run_Executor.md` | 1588 | `c9579abc2e14d7b44f5ac662b23daf7bff65f72d39c6011225c1db36cbd88875` |
| `05_Modules/05.9_Okta_Connector.md` | 1560 | `d679519010367687d12c7b0c74b77c938c0e717799c7202ff0e15e18ab3ad703` |
| `06_WorkPackages/06.0_WorkPackage_Register.md` | 9893 | `8b649d745c2d83de81e9fa1f5d8868ce7ac1fe5e33a24e06d05cc0acb68bb01c` |
| `06_WorkPackages/06.1_Dependency_Map.md` | 4588 | `d2fd095278dc6d103e3db291c44e8de62d6d3a4202a594ca225bb720fc4d4147` |
| `06_WorkPackages/06.2_Evidence_Index.md` | 951 | `920e59849445ba345355353d487e7cd1d9a2a64aa6b7cd5d65ca709fa9c55d48` |
| `06_WorkPackages/06.3_GitHub_Issue_Conversion_Guide.md` | 3349 | `6e0beb26b78a2bdce269f8b57aa37afe4384e9ee56517ea6b991b3c25e3f0201` |
| `06_WorkPackages/P0_Planning/WP-P0-ARCH-002.md` | 4958 | `c20abf4249c479976407e052ba6f1d0d18b8f1f37a78c6254cc2bcc50717990b` |
| `06_WorkPackages/P0_Planning/WP-P0-DEV-005.md` | 5669 | `a5bd71bfa911e00655a9aa7c66467bf98a76a4099aa4a5093306317655ffe552` |
| `06_WorkPackages/P0_Planning/WP-P0-GOV-001.md` | 5309 | `72fc49db24f6208d42c8a7e4ad9202a2d378a9b6c501d11a1b08b0a4df640941` |
| `06_WorkPackages/P0_Planning/WP-P0-REQ-004.md` | 4916 | `01383a3c678df43e3a87ea306707462a7e2234953a9b8d831f7771b5b32c556e` |
| `06_WorkPackages/P0_Planning/WP-P0-SEC-003.md` | 5017 | `68fca8643f2a825dabf35483f597d82236bbe255bfe2ac0b67e2e56451c1cdd6` |
| `06_WorkPackages/P0_Planning/WP-P0-UX-006.md` | 5243 | `340909f8e7546e8e950ac5b5a35590acfdc416ba10812e1343b6f501fcd02334` |
| `06_WorkPackages/P1_Foundation/WP-P1-AUD-004.md` | 9582 | `98ecd1f0c91f75dc0bfaf04bd93626d06fafcfcfe64c10f527b308d334345145` |
| `06_WorkPackages/P1_Foundation/WP-P1-BCK-007.md` | 5471 | `61493fa17ca2b89d91f474eeff1d36c4838c52c56c500865fafae054e84cf3e2` |
| `06_WorkPackages/P1_Foundation/WP-P1-CI-006.md` | 5859 | `6a68748540858a38a582d61c29c219526931aa8cdf8603307f8caa4b1404af30` |
| `06_WorkPackages/P1_Foundation/WP-P1-DATA-002.md` | 6760 | `2159688b128334cf880d4fc6d7694988bf3ba2b312df9eda139d797d82679906` |
| `06_WorkPackages/P1_Foundation/WP-P1-IDM-003.md` | 7314 | `f6ece4e1b3affd284da8bc55bb2ef86b3b5595b9b0baf00f4307b530b83546a5` |
| `06_WorkPackages/P1_Foundation/WP-P1-IDM-009.md` | 9801 | `5f299631b2b213a10cada05323d6622b14f987ce7945f279de36b9a22242e089` |
| `06_WorkPackages/P1_Foundation/WP-P1-IDM-010.md` | 9595 | `1377a376a181907a560f197e22d3dff91c450380850e670f5cc14c6d7826f765` |
| `06_WorkPackages/P1_Foundation/WP-P1-OBS-005.md` | 6593 | `f09a186e6124cab73c8fdc1a5746ad375b20a9032a2ce8b8babe8d66456e113f` |
| `06_WorkPackages/P1_Foundation/WP-P1-PLAT-001.md` | 5923 | `b2e7f5917cbaa40a58580bf9c23c8ac461d790057581b59dafc62b38b73eafe8` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-CLOSE-014.md` | 7874 | `88a9060d7883047a73e846e34baef79ea290df6673c963b91b3645e3a6e8970b` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-COLLAB-004.md` | 8423 | `10eb51a3d7b1d0a20a8090b2041d4dadf24e74e4e3d34fed6d1528c50c6f4dfa` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-GATE-007.md` | 6043 | `e7fb73a5b1c72e3b3f6d19ac23d0173a2021b19e6c65b7cda9cb4147e002d570` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-NTF-005.md` | 13785 | `12de6779d5f4e4d27fa0a8802b55c3c56acc50f627d9f0541b9222b851401245` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-OPS-003.md` | 7688 | `8282ff4467c97035370ebc0da15cc818b09450ccf58fcd2fc0d75387c1a2746c` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-OPSUI-010.md` | 9283 | `9f3f15ec522600ef01db8c5d56f4c3e3850fa563cf13ed0fae6fdd7c4389c8e6` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-PORTAL-002.md` | 8379 | `25553e787c59678870df301ebf7a037ba1670525d6dd5429ac9032407448822a` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-PRIO-013.md` | 7396 | `a2f4832c3bc67d9f25390f53d9c050ff875c367fba86d3b6bd4661513bb1dc77` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-REL-009.md` | 10649 | `35e4e5fdddc3ccf58f023da1a36b5118f4e75578d2bc0531e9d7ef902fc45163` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-RELUI-012.md` | 9572 | `e88ead4cc06ac8f481983e10bf11443480a9a4ac15a8538c0d3a2743e7a4aff4` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-SCAN-011.md` | 13071 | `7de75d9ba7a27fe2e490f4986f09112635c614c19401291ba2a82d78421fa616` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-SEARCH-006.md` | 8519 | `95e707373ed383a3aabcd88f883129eb080e6c58c81dcfb52852673ac1f693bf` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-SLO-008.md` | 9192 | `d11e4f86eece5b042ad3848a24afa33849ec57c7c1f3e8817bb45f7e1b96e2d6` |
| `06_WorkPackages/P2_Ticket_MVP/WP-P2-TKT-001.md` | 8356 | `dd50e0d5e4fa5ee259be3f912d09830af9570d5b6fdb7f3a9d1c89e13d35ac59` |
| `06_WorkPackages/P3_Knowledge/WP-P3-AI-004.md` | 2801 | `03d48931d82108cdb9bc6c036e6696285620df7a00907f8f299f492427edb4f0` |
| `06_WorkPackages/P3_Knowledge/WP-P3-KNW-001.md` | 2741 | `f001d2c24099e5178b4220ccc516568ca35531cff896bf6094dbda64c2881942` |
| `06_WorkPackages/P3_Knowledge/WP-P3-LINK-003.md` | 2680 | `698b45699928c6ecd0bbc51cc653d82aa09564026cad7c70afd05e2035ed9557` |
| `06_WorkPackages/P3_Knowledge/WP-P3-MIG-005.md` | 2724 | `b64ae45c26c04532dccf21136cd750bd7e76c70882042186c7b52f73512e4821` |
| `06_WorkPackages/P3_Knowledge/WP-P3-SRCH-002.md` | 2711 | `a41a8720219a21b2c186a909828ced566eeff724216f32697d2c4009709b15ef` |
| `06_WorkPackages/P4_Approval_Automation/WP-P4-APR-002.md` | 6967 | `43a744fa898494ccab3c8074a5dc180a6f6fb0c950b35f3aee50eecd159ee4d3` |
| `06_WorkPackages/P4_Approval_Automation/WP-P4-CAT-001.md` | 2747 | `0d2d0e25bc421e3f9d1e3edfa4100ef84ee430a3ccab84a37b6a2c92653775f1` |
| `06_WorkPackages/P4_Approval_Automation/WP-P4-ENTRA-006.md` | 2752 | `fb847d4895c7df5378a298d34548dc6b3701cee7ff24f09b7cf881e2b2b0d8d1` |
| `06_WorkPackages/P4_Approval_Automation/WP-P4-EXEC-004.md` | 7009 | `db98bce4fd7e5554dcb2afd769a08a0533d072cbcf68392efc2e6fcad84719bd` |
| `06_WorkPackages/P4_Approval_Automation/WP-P4-EXEC-008.md` | 6273 | `0d19cec54e1c0e1d6216e7dc6dd9e8fb3ae59597b6a5c6afa5bfa8b27683d63a` |
| `06_WorkPackages/P4_Approval_Automation/WP-P4-EXEC-009.md` | 6367 | `89b534454e21ba91556b208b0b50c0fd4bcbe835f0358b2eefd1530dd69c625b` |
| `06_WorkPackages/P4_Approval_Automation/WP-P4-GATE-007.md` | 2931 | `a70ca63d14a1291913b2ce7816e181d2323f821e2b0aff6d651ca0f1a6f759e6` |
| `06_WorkPackages/P4_Approval_Automation/WP-P4-OKTA-005.md` | 2742 | `5ce3b926fbf3ef0ef906dfe6df1697ea6185f3e09b705b8894035935d2695a78` |
| `06_WorkPackages/P4_Approval_Automation/WP-P4-WF-003.md` | 3180 | `b531df8abea7d22702c88dc3e1516b17afd907d0421fdf94f2561a6afbc48724` |
| `06_WorkPackages/P5_SCIM/WP-P5-GROUP-003.md` | 2727 | `855756aa2aa8a1f4d41fcc0c38a9d2328f85ddbf090e804d741bbc77c3862fee` |
| `06_WorkPackages/P5_SCIM/WP-P5-IDP-004.md` | 2821 | `b83d9ea551973af8ab5873771711e95f99af3b01ae1503ab428c6d4608b73c0e` |
| `06_WorkPackages/P5_SCIM/WP-P5-JML-005.md` | 2723 | `c524b67f9f45ed62d37e3a0ac52c18ae756e0e269ee8a36e8964b9675a7e980b` |
| `06_WorkPackages/P5_SCIM/WP-P5-SCIM-001.md` | 2696 | `e053f0091a41bcae40fd6cf0fc8545e73dedfe466de46a018b5716220d0501a0` |
| `06_WorkPackages/P5_SCIM/WP-P5-USER-002.md` | 2737 | `42f69c6e5cbabe9075632e5f569a7644b36ef59dc340be49ae1d473e8fb1710b` |
| `06_WorkPackages/P6_Asset_CMDB/WP-P6-AST-001.md` | 2678 | `c5f80b0d609b96084e792a7ba124236060c5019c05069ad14a73a87f0bc6e66f` |
| `06_WorkPackages/P6_Asset_CMDB/WP-P6-CSV-002.md` | 2662 | `6515266187ee95cf917a74a35acc4b8054ea0a65125de3e85bd0c0caf0ab7c7c` |
| `06_WorkPackages/P6_Asset_CMDB/WP-P6-REC-003.md` | 2687 | `c216ab4f2273ed170d075c0098310b6b027699f1a25b619698405275f7f021eb` |
| `06_WorkPackages/P6_Asset_CMDB/WP-P6-REL-005.md` | 2742 | `6859ae2d1755fa1afe544ea1ee296b6bd6d5cda40808dec5dfc199961fef77e7` |
| `06_WorkPackages/P6_Asset_CMDB/WP-P6-SYNC-004.md` | 2744 | `fe26b9f5b49bda3e43429af8fcef7a9e2d648972bce0ff88999da168b5daec1f` |
| `06_WorkPackages/P7_Change/WP-P7-APR-002.md` | 2655 | `4e473d919a7e3bd1ca3bbb8eb4a5ede3c5343fc3da96aa0456a007539664de45` |
| `06_WorkPackages/P7_Change/WP-P7-CAL-003.md` | 2633 | `a162a220df744e4d1a78490bb119ca519d9438e932d6de907d0eb7c4db09fe23` |
| `06_WorkPackages/P7_Change/WP-P7-CHG-001.md` | 2699 | `21256196ec507b398f3b09f054b94964dcddc71ef28ede3747f7754c7d2a63f2` |
| `06_WorkPackages/P7_Change/WP-P7-PIR-004.md` | 2760 | `3861e1ef3a66add71aa44d1f0fd15b85b4ba1afcb15a6e9bec70376a6efdf9d4` |
| `06_WorkPackages/P8_AI/WP-P8-CLS-001.md` | 2732 | `ab886c10aef9995c5168dc81c0594e16e0d40f8ec5bbfb605a220b6681f7ca20` |
| `06_WorkPackages/P8_AI/WP-P8-EVAL-004.md` | 2781 | `30a16ed60abda1e42a27a4a07e0bd662877daa6be81bf7ed6472cfbb82755076` |
| `06_WorkPackages/P8_AI/WP-P8-OPS-005.md` | 2776 | `c9633905ff489f2249a1d3c4df38f3d461e2b8e67826ad1f99415fcfe8669bca` |
| `06_WorkPackages/P8_AI/WP-P8-RAG-002.md` | 2848 | `f9ab46a99e3326d6b12f47df8ee65f81fdcfc3eeba9ae49c0b8cef8445abcd5e` |
| `06_WorkPackages/P8_AI/WP-P8-SEC-003.md` | 2854 | `0136325c12fca0192e36a3cd2a38fd49753f9ee7f3659ccf8eefbf8ff4cd032a` |
| `06_WorkPackages/P9_Migration/WP-P9-ADP-004.md` | 2765 | `b23886d874315ec181de20b0acecad89146158adaf0c9248ad346bdbdf1f69f4` |
| `06_WorkPackages/P9_Migration/WP-P9-GATE-005.md` | 2870 | `592b505601b44fdb467aab7a1558e7b47df8cb14b864da26a095853fb02683cf` |
| `06_WorkPackages/P9_Migration/WP-P9-MIG-001.md` | 2807 | `fd52d88d6792a4d1c10bcf260004f8dd16c6c4e9a3259dfa9a9485359f6e6fc5` |
| `06_WorkPackages/P9_Migration/WP-P9-OPS-003.md` | 2773 | `dde5a568bc28caaa152ae79ef0a9229ff6d2789cac832294162f5cef48635234` |
| `06_WorkPackages/P9_Migration/WP-P9-PAR-002.md` | 2713 | `9b330a4af54d744267806e905c2da40d9c2a8bb85418eceb1e70d9b81a59a2f8` |
| `07_ADR/07.0_ADR_Index.md` | 4874 | `eefd58f9a5c780c7a0981489bf7edc357362685a558f24aebf21c3500d49a40b` |
| `07_ADR/ADR-0001_Modular_Monolith_First.md` | 3381 | `fa08e6ec693de5fe82995b0e944504de53dfd88f380cb8c9d45c40ea88229259` |
| `07_ADR/ADR-0002_TypeScript_Core_and_Python_AI.md` | 2443 | `e5cc4bbfd293d3b30cd0f87aba7607a7b07181f7db3df5f771f31ece70559f66` |
| `07_ADR/ADR-0003_PostgreSQL_System_of_Record.md` | 3047 | `d9450004d8efc3cf8f341e12db3677e9f36043cb7b88a5c8ec41a5e6a84468cd` |
| `07_ADR/ADR-0004_External_Identity_OIDC.md` | 3283 | `14fd211469ab652089c21969cf57de044e332a981a7b44ae1aabdfb00a9a1251` |
| `07_ADR/ADR-0005_SCIM_Service_Provider.md` | 3282 | `3a9e3df863f12d09293bdf55abd462999269ea1c58e1451024a4f3be925b464a` |
| `07_ADR/ADR-0006_Privileged_Executor_Separation.md` | 3571 | `cbcbabac7e8fd58ebba7546a04aa1c9357e38435365e83587531dd108d88ea76` |
| `07_ADR/ADR-0007_AI_Advisory_Only.md` | 3134 | `da8219ca23dfad49739a7b4acd04a2dbcf7daf18e7f4dc3b957007ef5d81a6e4` |
| `07_ADR/ADR-0008_Transactional_Outbox.md` | 2777 | `14871747daec0a16585978c4a44fcc9772f1acfc77ec64051afe50501613a73f` |
| `07_ADR/ADR-0009_Append_Only_Audit.md` | 3247 | `1f78363c6dd56216e853e37dfae493497a8f959b2beb3efb58f7ab8c87e6fc9d` |
| `07_ADR/ADR-0010_S3_Compatible_Attachments.md` | 2970 | `c411eca8b8a8b5a9b5d5ac7f0170b97b7ebcfd404b6060d3c898e599cb64c4a8` |
| `07_ADR/ADR-0011_Postgres_FTS_then_pgvector.md` | 3537 | `6629a02856e093ddf3b5878a567bf6c77b1ab429652f24f5a0caf70bc9bf5cb3` |
| `07_ADR/ADR-0012_Defer_Temporal.md` | 3131 | `2102c721d02dac54bd371fd25332f57dbcaa9311138b71ab19c640e513a61883` |
| `07_ADR/ADR-0013_Current_State_Plus_Append_Only_Events.md` | 2750 | `0f647176553e5ad3923dccd8c51ce3c49fde64f6e6fe98e303706fb95a3a6e53` |
| `07_ADR/ADR-0014_No_Custom_Inventory_Agent.md` | 2756 | `867e543646d11746c102e08a80d5a545b98c3c0e5bc0bda77c8fafa33531ae58` |
| `07_ADR/ADR-0015_Organization_Isolation_and_RLS.md` | 3742 | `6a14af3250b9a05d6fb9b6a816a6d7a456a5474d802809356ee58e8ca9e5b228` |
| `07_ADR/ADR-0016_Secret_Management.md` | 3420 | `8c4252c85b14c42b8704463f766fac0025c90cefad83924789707b253b0a8232` |
| `07_ADR/ADR-0017_API_and_Webhook_Contract.md` | 3218 | `80f92a3989d0bdc27ae180fe7dcc8b4fe011230a6e5d84348ee443815efb243d` |
| `07_ADR/ADR-0018_Deployment_Baseline.md` | 3780 | `4741793dda623a16e0d87754494eac4080bdb74e151584c2252db5c43995c71f` |
| `07_ADR/ADR-0019_Local_Authentication_For_Development.md` | 8086 | `3f6f583a336031f04ab47ea178658cc377da436cf25b6b2fd80c01cf03d9016b` |
| `08_Runbooks/08.10_Audit_Export.md` | 1469 | `bb53a1a948cd80930b2c54fc35fa61cfde15402be7fe1343fe79b323fe93785a` |
| `08_Runbooks/08.11_Data_Reconciliation.md` | 1469 | `66e555c4385a67399c03768b05450f30a69ae382b54ae23db9b4dfe526ef49ab` |
| `08_Runbooks/08.12_Security_Incident.md` | 1502 | `073b4046e12371a776cfa1d45ce7f2f3cc9563e2755dfcabc1d8a1398b9743c6` |
| `08_Runbooks/08.13_Break_Glass_Runbook.md` | 5283 | `0f8da01e703d47125cb30827be78e09797fcf41c650d8e8019d62ecebbe505d0` |
| `08_Runbooks/08.1_Deployment_Runbook.md` | 10025 | `7d4838623b60ffbff27649f91f1d7b937b9ec933f9b34597d64a48bc304b97d2` |
| `08_Runbooks/08.2_Backup_and_Restore_Runbook.md` | 6266 | `89de0b30368141562493373bc2c488221882dd8e59673ad3d6a8749e397be15f` |
| `08_Runbooks/08.3_SOLVI_Incident_Response.md` | 10758 | `0e0b9c4cda3ef99a6d8ad0f6f62773384f26da1126cb23a8721b5ac712749aa5` |
| `08_Runbooks/08.4_OIDC_Outage_Runbook.md` | 1447 | `debe079fa51ec66b6e7037666a244f980884f31049c360089bc76058c8b2eca8` |
| `08_Runbooks/08.5_SCIM_Failure_Runbook.md` | 1477 | `54fa94736502b13cbe3c9cddacfa5247d6d5b4671e7d6ae165345dae1fddf141` |
| `08_Runbooks/08.6_SOLVI_Run_Failure.md` | 6540 | `def8e9d08702cd59e5b67fe25f338e8a6054a1ccacee44e3ea7d82a22e205a58` |
| `08_Runbooks/08.7_Executor_Credential_Rotation.md` | 1477 | `f6e8d9fb9ce2960d4f73a0bcc3908c7f5ea22d392fd17cccd1a1001ddfa524c8` |
| `08_Runbooks/08.8_AI_Kill_Switch.md` | 1479 | `07da36a1a8b4b420c7dcce9c02695da23ea184737a21e90c0947c7c9b416ea3a` |
| `08_Runbooks/08.9_Migration_Rollback.md` | 1476 | `905cc037ec2693c789c8b14b30e7ce6faaff7c58b3c2529d46a6ef8b1c2df0e1` |
| `09_Templates/09.10_Knowledge_Article_Template.md` | 764 | `72ba0318a55af68e22f7567c609ac63213bf27e2bd052e88aef4dc46ca219eaa` |
| `09_Templates/09.11_Catalog_Item_Template.md` | 785 | `ab055754cfb6b62b184882aba93723d6ea35d2409e8a3822418d77a1d734c7bc` |
| `09_Templates/09.12_Change_Record_Template.md` | 794 | `b974cbe5d469088ba3513b058c998b5c015a1ab18eb1f8726a6e923123cf455b` |
| `09_Templates/09.1_ADR_Template.md` | 3133 | `e0d839f9b1a1e29492fb4397d97f3fb54997be6b589ed5af2dd604d7d221b8f6` |
| `09_Templates/09.2_WorkPackage_Template.md` | 3790 | `b2407cb5eae085cd8db09e095236293dbee706c55c09d429f4ce60ee418d3869` |
| `09_Templates/09.3_GitHub_Issue_Template.md` | 741 | `0057392601479b9002bcf51dfb1d87ea1788ae1b4c9461982ae1d49362ba28c1` |
| `09_Templates/09.4_PR_Template.md` | 761 | `cbafc0bf2664c2e8d291dca09fefc87b36f6d2c9b7b93dbc945063e5e8c22a29` |
| `09_Templates/09.5_Test_Case_Template.md` | 777 | `d4e7a6cc28332c7c8745df77607c5e4703977460f09c77db90c06547882b26ae` |
| `09_Templates/09.6_UAT_Scenario_Template.md` | 770 | `1ac0f3930388f2ec1ece39d98b261a73f0f6842340e01fe8f7101b98404bb040` |
| `09_Templates/09.7_Risk_Template.md` | 746 | `bbe1c9e92ed1c5870c68e8e795ec071c6f28a290302f99c8705f16dd8426e893` |
| `09_Templates/09.8_Decision_Log_Template.md` | 715 | `a7dc632615a8696437de37e254a60b2ad0ee9dd11b30437808e0f170c4a1b4f0` |
| `09_Templates/09.9_Runbook_Template.md` | 3154 | `ab86454ab408d20a5e716e6dd71859c912e8e9dfcd284091db1a06f70ccbc3f0` |
| `10_Research/10.10_Build_vs_Buy_TCO.md` | 1359 | `88d480ae3ac8847dc4f3d51cbafe9d830ea8bc0ffcfe2b5e63ae96d11e224eb2` |
| `10_Research/10.1_GLPI_iTop_Community_Constraints.md` | 1443 | `d93a9bbaf2799767cda49639b8e87dee30ca4617fdd6d7f4c16193b7a85e6fb8` |
| `10_Research/10.2_Freshservice_Function_Gap.md` | 1372 | `c5f604a22265d5f8bb206516b00fac150200e3d8ab17ea8cda6d734d46e14bb1` |
| `10_Research/10.3_OIDC_SCIM_Research.md` | 1320 | `ca3e5ca7a50f15f530a160be2139ceccd1c150c154e633c79097ae233fb06343` |
| `10_Research/10.4_Okta_Management_API_Research.md` | 1339 | `fb49111f387591f145c7c187dd43db4f79fa8b5a5d2abc64d6898359f48d4d92` |
| `10_Research/10.5_Microsoft_Graph_Research.md` | 1321 | `2fc4756c69358477e034a7998942f0f23282b91b65220ed0e3d59ae4bde1eafa` |
| `10_Research/10.6_Workflow_Engine_Research.md` | 1371 | `02fadb27ce52a734e11ab52f3ba76f125652113b43b8212977928f818a4b813f` |
| `10_Research/10.7_ITSM_Practice_Research.md` | 1353 | `184852f5a10e59d2474efaa5f3dd3599d89f664e3491df89dd0bdfa149c1e477` |
| `10_Research/10.8_AI_for_ITSM_Research.md` | 1313 | `f9aef3826e2c24fec9176a9fe43c9a85ea1c51a9b2b77caeb6ed2100559616cf` |
| `10_Research/10.9_PostgreSQL_RLS_and_MultiOrg.md` | 1318 | `58d1465069a01a5dc45ceec88894b3d97b40b2e9f5aaf4b3cae2cf9df0d1610d` |
| `11_UI_UX/11.10_Accessibility_and_Content.md` | 1642 | `1b7e8ad0c02383dd1edb828b46e76675f83c818150cf001e10cc1d5af16d7159` |
| `11_UI_UX/11.11_UI_State_and_Error_Model.md` | 1651 | `7e70920115b57cdaefae3ca8bd8d31331fa925a23d9f223011e746178b32962a` |
| `11_UI_UX/11.12_UI_Roadmap_and_Test.md` | 1631 | `fe76e12ceed5f49358219200b2e5fb179239f9c2afe81fa8746e1e9459d4bffa` |
| `11_UI_UX/11.13_Mockup_Asset_Index.md` | 3345 | `4202041154cb3e037ddd826343658e4248c71ecd78c6db4c614b7675db38c51b` |
| `11_UI_UX/11.1_UI_Strategy.md` | 1640 | `96b0a6215acaa2d8754d2685b91263f7e57ad0debfaadfc2bbde73d52263c55c` |
| `11_UI_UX/11.2_Information_Architecture.md` | 4725 | `a1a97e39e22e5088e0b9033c82f3fa16a306de8a7f8dfb275b67bd20c00c54b3` |
| `11_UI_UX/11.3_Design_System.md` | 1617 | `5d0d8051d0d85de97b1d5493e7ccaa80848d21c8787297c3120947e8b3dcc5d7` |
| `11_UI_UX/11.4_User_Portal_Mockup.md` | 1690 | `6fcda3c44d2d5774da8d759d1a56109a5f8f9efbe968de3bb4e92d333873139c` |
| `11_UI_UX/11.5_Request_Flow.md` | 1542 | `3182d8d3687daabd73883c49f7110c45e3d42820f865d740c6c172ca014a123b` |
| `11_UI_UX/11.6_Incident_Flow.md` | 1658 | `773c2dfd4dced4624fb32d1058a15ec3665a305153f5bbd9e9b27bbf352e0f0e` |
| `11_UI_UX/11.7_Admin_Dashboard_Mockup.md` | 3216 | `b61759fdf4103d2589fd7bd03ce1251a3a9990a06df9e8618b292195019a1462` |
| `11_UI_UX/11.8_Ticket_Management_Mockup.md` | 3207 | `27f1609cd6b20a00883f55f20d54cc9bdc838eeccadb0a37c565235b5cc589d8` |
| `11_UI_UX/11.9_Admin_Settings_Mockup.md` | 4252 | `6a60fdf0562c75324c5bfe13c8d1b0044831aae5304a12209e1ed818992bbc88` |
| `99_Project_Files/99.10_Budget_and_TCO_Model.md` | 1545 | `cdb41a6c2291a9a55d24190fc3566eb0ed4d742a95e6bf1d29092e0574d3c118` |
| `99_Project_Files/99.11_Codex_Handoff.md` | 1497 | `d4ae4aab5cb6b6ed875f2b7c2e13fd9913841b180f9ab1a55da0e022ec7dbc9c` |
| `99_Project_Files/99.12_Codex_First_Prompt.md` | 3727 | `9bd0af8f362512556bfa1961499c858aed8233aa3acd17b09f8a41d7cb5e996a` |
| `99_Project_Files/99.13_Vault_Validation_Report.md` | 4685 | `507aa4d3fc393c09c9b2c3ee82f83c99394c76d6b7cbe724ccd8661632355383` |
| `99_Project_Files/99.1_Project_Charter.md` | 1618 | `d5ab4c80b5cf2c59f0a3ab2197a922e6c3fc5ba8eb846ec3af9821dbc06cb6ca` |
| `99_Project_Files/99.2_Assumptions_and_Constraints.md` | 1372 | `83af0468573706bd83a680c4e733e0040f93d2a714945d418ef6111a4eea2022` |
| `99_Project_Files/99.3_Risk_Register.md` | 2652 | `89379a0103d2629390332ee025f05fb21d4efb1fc5772aa6ca60ff407339994f` |
| `99_Project_Files/99.4_Decision_Log.md` | 17935 | `82b9af0f4bda2ff24fe5c7522db0f2025408cd5adc048746f437a0d580e9cae1` |
| `99_Project_Files/99.5_RACI.md` | 1264 | `01cb89afea01760e7ac8bdc2346e5b4dcc9174155942ac30ac62b5528d90fb47` |
| `99_Project_Files/99.6_Communication_and_Meeting_Cadence.md` | 1559 | `a31a3d6940debb89be254c8274dc5e0be0ca192b598d45817b786abb4347b3b3` |
| `99_Project_Files/99.7_Environment_and_Integration_Inventory.md` | 3902 | `9f9e244da211eda16fbd7458b0acfa2503c891675af606a71287cad177806938` |
| `99_Project_Files/99.8_Migration_Inventory.md` | 1558 | `33fea831ba9d74e2b1c5e0f5f19ce3e30a6c27dd0f342d5d89b83e8cb8b0a1c2` |
| `99_Project_Files/99.9_Evidence_and_Audit_Plan.md` | 1534 | `7d8dc20c9683b22038bf8af7c56ed266b5b1b8881fefbe81502647b4eb2948c2` |
| `AGENTS.md` | 7220 | `9140be18c5a8c80d11af04b922da96e2cf74575a4e570f653a6f39e023bf18be` |
| `README.md` | 4938 | `8b45541328654353d3811f9ece449c6c0f76fced0a472694c6427e15298d4907` |
| `assets/README.md` | 1428 | `bf711fb8fcea557559cd29eb761a6ed2ee362d1161005239eef0021db598ced5` |
| `assets/brand/SOLVI_Logo.svg` | 704 | `d9553179b43561a086434692a7bc2640cca0c23a92d535378424877ed6de0ba9` |
| `assets/references/Freshservice_Reference_Catalog.png` | 640140 | `feb150c574a92cd9b497680f82d9159e8fe83d3007d0fb4efca972ba0ad7b882` |
| `assets/references/Freshservice_Reference_Portal.png` | 424254 | `eebad45edd345b904928bb98cfd8c5744b971b1b00b8172c5b7634da5bb18afe` |
| `assets/references/Shirokuma_Vault_Structure.png` | 77239 | `59e9a9f4d73643851ea75c7a6c5207d51e42d16ad2e3b13bf9bc730a37f1d80b` |
| `assets/ui/SOLVI_Admin_Dashboard_v1.png` | 1263410 | `e2adc930bb570cf01c634c89af84d0cfff580418cf7cad8437e7a820b041c952` |
| `assets/ui/SOLVI_Admin_Settings_v1.png` | 1115712 | `7b4660412e2a34eb0327bf891ea6c0a24bef27006e7b836e44a15c45b5f29bd5` |
| `assets/ui/SOLVI_Ticket_Management_v1.png` | 1115012 | `2b2b6e98a194390ba4fc0d939df2f6dff4f50fe67405b5c3d9a59bf8abd65058` |
| `assets/ui/SOLVI_User_Portal_Home_v1.png` | 1247438 | `50433411a5d58bb162df6e5daf0da614179f22211e171115d3a578300697058a` |
