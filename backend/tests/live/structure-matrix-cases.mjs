// Product acceptance cases, separate from the frozen benchmark. All model
// generation, interpretation and tool selection must use the real backend LLM.
const steel = '材料为Q235B，E=206000MPa，泊松比0.3，密度7850kg/m³；所有杆件采用实心矩形截面，宽100mm、高200mm。';
const controls = '采用全局Z向上，二维结构在XZ平面；不计自重，不考虑P-Delta、刚端和楼板刚性假定。仅做线弹性静力分析，输出反力、内力与位移，不做规范验算或报告。所有已给几何、材料、截面和荷载均已确认。';
const frame = '三维一层框架，X方向一跨4m，Y方向一跨5m，层高3.6m，四根竖柱的柱脚完全固定，四根屋面周边梁与柱刚接。各柱顶在恒载工况D下分别施加竖向向下50kN节点力；不设其他荷载。材料Q235B，E=206000MPa，泊松比0.3，密度7850kg/m³；柱和梁均为实心矩形300mm×300mm。不计自重、不考虑P-Delta、刚端及刚性楼板。只做线弹性静力分析，输出反力和柱顶竖向位移，不验算不生成报告。以上均为已确认输入。';
const simple = `6m简支梁，左端铰支右端滚支，跨中竖向向下10kN集中力。${steel}${controls}`;
const arch = `二维折线拱，依次连接XZ坐标(0,0)、(1,1.111111111111111)、(2,1.777777777777778)、(3,2)、(4,1.777777777777778)、(5,1.111111111111111)、(6,0)，两拱脚均完全固定，各段为刚接梁，拱顶竖向向下10kN节点力。${steel}${controls}请使用通用技能按这七个点建模，不要用标准梁或门架替代。`;
const mixed = `二维框架与支撑混合结构：A=(0,0,0)、B=(5,0,0)、C=(0,0,3)、D=(5,0,3)，A、B完全固定，AC和BD是柱，CD是梁，AD是仅承轴力的铰接斜支撑；梁柱刚接。在D施加全局X向10kN节点力。${steel}${controls}仅使用通用技能，保留斜支撑轴向单元行为。`;
const os = 'opensees-static';
const scenario = (id, skill, prompt, oracle, engine = os, extra = {}) => ({ id, skill, engine, prompt: `${prompt}\n请只使用${engine}引擎；若不支持请明确说明，不能换引擎或改变物理模型。`, oracle, ...extra });
export const cases = [
  scenario('beam-specialist', 'beam', simple, { total: [0,0,-10], nodes:3, beam:{ L:6,P:10,E:206000,B:100,H:200 } }),
  scenario('beam-generic', 'generic', simple, { total:[0,0,-10], nodes:3, beam:{L:6,P:10,E:206000,B:100,H:200} }),
  scenario('arch-generic', 'generic', arch, { total:[0,0,-10], nodes:7, members:6, extent:[6,0,2] }),
  scenario('mixed-generic', 'generic', mixed, { total:[10,0,0], nodes:4, members:4, axialBrace:true, extent:[5,0,3] }),
  ...[os,'pkpm-static','yjk-static'].map(engine => scenario(`frame3d-${engine.split('-')[0]}`, 'frame', frame,
    { total:[0,0,-200], nodes:8,members:8,extent:[4,5,3.6], axialFrame:{P:50,L:3.6,E:206000,A:.09} }, engine)),
];

const continuous = `两跨等跨连续梁，每跨6m，三个支点位于x=0、6、12m，左支点铰支，其余滚支，中间支点不断开转角；两跨满布竖向向下10kN/m均布荷载。${steel}${controls}`;
const column = `3m高的竖直悬臂柱，柱脚完全固定，柱顶竖向向下100kN节点力。${steel}${controls}`;
const portal = `二维双坡单跨门式刚架，左柱脚(0,0)、左檐口(0,4)、屋脊(6,6)、右檐口(12,4)、右柱脚(12,0)，这里坐标为XZ；两柱脚完全固定，各梁柱连接刚接。在屋脊施加竖向向下30kN集中节点力。${steel}${controls}`;
const truss = `二维三杆三角桁架，节点A=(0,0,0)、B=(6,0,0)、C=(3,0,4)，杆AB、AC、BC都只传轴力、所有节点铰接；A铰支，B在X方向自由、竖向约束，约束平面外自由度。C竖直向下10kN节点力。${steel}${controls}`;
const irregular = `二维两层两跨钢框架，跨度依次4m、5m，层高依次3m、3.5m，三个柱脚完全固定，全部梁柱刚接。在每层三个梁柱节点上分别施加竖向向下30kN与X向右10kN节点力。${steel}${controls}`;
const concrete = '二维两层一跨混凝土框架，跨度6m，两层层高均3.6m，两柱脚完全固定，全部梁柱刚接。材料C35，E=31500MPa，泊松比0.2，密度2500kg/m³，钢筋HRB400；柱500×500mm、梁300×600mm矩形截面。在每层两个梁柱节点上分别施加竖向向下60kN与X向右10kN节点力。不计自重、不考虑P-Delta、刚端和刚性楼板。只做线弹性静力分析，输出反力、内力与位移，不验算不生成报告；以上输入均已确认。';
for (const [id,skill,prompt,oracle] of [
  ['continuous','double-span-beam',continuous,{total:[0,0,-120],supportReactions:[[0,22.5],[6,75],[12,22.5]]}],
  ['column','column',column,{total:[0,0,-100],nodes:2,members:1,extent:[0,0,3],axialFrame:{P:100,L:3,E:206000,A:.02}}],
  ['portal','portal-frame',portal,{total:[0,0,-30],nodes:5,members:4,extent:[12,0,6]}],
  ['truss','truss',truss,{total:[0,0,-10],nodes:3,members:3,extent:[6,0,4],truss:true}],
  ['irregular-frame','frame',irregular,{total:[60,0,-180],nodes:9,members:10,extent:[9,0,6.5]}],
  ['concrete-frame','concrete-frame',concrete,{total:[40,0,-240],nodes:6,members:6,extent:[6,0,7.2]}],
]) for(const selected of [skill,'generic']) cases.push(scenario(`${id}-${selected==='generic'?'generic':'specialist'}`,selected,prompt,oracle));

cases.push(scenario('inclined-truss-generic','generic',truss.replace('B=(6,0,0)','B=(6,0,2)'),{total:[0,0,-10],nodes:3,members:3,extent:[6,0,4],truss:true}));
cases.push(scenario('grid3d-generic','generic',`三维一层规则框架，X和Y方向均为两跨、每跨5m，层高3m，底部九个柱脚完全固定；共九根竖柱，顶部沿X和Y相邻网格节点间均布置刚接梁。顶部九节点每点施加全局X向1kN节点力。${steel}${controls.replace('二维结构在XZ平面；','')}仅使用通用技能。`,{total:[9,0,0],nodes:18,members:21,extent:[10,10,3]}));
cases.push(scenario('beam-en','beam','Analyze a simply supported 6 m beam with a downward 10 kN point load at midspan. Q235B steel, E=206000 MPa, nu=0.3, density=7850 kg/m³. Solid rectangular section, width 100 mm and depth 200 mm. Global Z up, 2D XZ plane, left pin and right roller. No self weight, rigid offsets or P-delta. All dimensions, materials and loads are confirmed. Return linear static reactions, forces and displacements only; no design check or report.',{total:[0,0,-10],nodes:3,beam:{L:6,P:10,E:206000,B:100,H:200}},os,{locale:'en'}));
cases.push(scenario('generic-knowledge-disabled','generic',simple,{total:[0,0,-10],nodes:3,beam:{L:6,P:10,E:206000,B:100,H:200}},os,{policy:{knowledge:'disabled'}}));
cases.push(scenario('unrestricted-routing','beam',simple,{total:[0,0,-10],nodes:3,beam:{L:6,P:10,E:206000,B:100,H:200}},os,{policy:{skillIds:null,routing:{mode:'auto'}}}));

const rc3d=frame.replace('材料Q235B，E=206000MPa，泊松比0.3，密度7850kg/m³','材料C35混凝土，E=31500MPa，泊松比0.2，密度2500kg/m³，钢筋HRB400');
for(const engine of [os,'pkpm-static','yjk-static']) {
  const name=engine.split('-')[0];
  cases.push(scenario(`frame3d-generic-${name}`,'generic',frame,{total:[0,0,-200],nodes:8,members:8,extent:[4,5,3.6],axialFrame:{P:50,L:3.6,E:206000,A:.09}},engine));
  cases.push(scenario(`rc3d-${name}`,'concrete-frame',rc3d,{total:[0,0,-200],nodes:8,members:8,extent:[4,5,3.6],axialFrame:{P:50,L:3.6,E:31500,A:.09}},engine));
  cases.push(scenario(`selfweight-rc3d-${name}`,'generic',rc3d.replace('密度2500kg/m³','容重25kN/m³').replace('不计自重','将杆件自重计入恒载工况D'),{total:[0,0,-272.9],nodes:8,members:8,extent:[4,5,3.6],densityUnitWeight:25},engine));
  const multiple=frame.replace('不设其他荷载','另设活载工况L：四个柱顶各施加全局X向20kN节点力。定义线性组合U=1.3D+1.5L，必须分别计算D、L及U三组结果');
  cases.push(scenario(`cases3d-${name}`,'frame',multiple,{totals:{'case:D':[0,0,-200],'case:L':[80,0,0],'combination:U':[120,0,-260]},nodes:8,members:8,extent:[4,5,3.6]},engine));
}
for(const engine of ['pkpm-static','yjk-static']) cases.push(scenario(`unsupported-2d-${engine.split('-')[0]}`,'beam',simple,{total:[0,0,-10]},engine,{expect:'refused',allowedCodes:['ENGINE_INPUT_UNSUPPORTED','ENGINE_MODEL_FAMILY_UNSUPPORTED','ENGINE_UNSUPPORTED']}));
cases.push(scenario('no-structure-skills',null,simple,{},os,{expect:'refused',policy:{skillIds:[],routing:{mode:'auto'}}}));
cases.push(scenario('disabled-requested-engine','beam',simple,{},os,{expect:'refused',policy:{providers:{preferredIds:[],disabledIds:[os,'pkpm-static','yjk-static','opensees-dynamic','opensees-seismic','opensees-nonlinear']}}}));

// Independent force moments about the global origin, fixed before execution.
for(const item of cases) {
  if(item.id.startsWith('beam-')||item.id==='generic-knowledge-disabled'||item.id==='unrestricted-routing'||item.id==='arch-generic'||item.id==='inclined-truss-generic'||item.id.startsWith('truss-')) item.oracle.moment=[0,30,0];
  if(item.id==='mixed-generic')item.oracle.moment=[0,30,0];
  if(item.id.startsWith('continuous-'))item.oracle.moment=[0,720,0];
  if(item.id.startsWith('portal-'))item.oracle.moment=[0,180,0];
  if(item.id.startsWith('column-'))item.oracle.moment=[0,0,0];
  if(item.id.startsWith('irregular-frame-'))item.oracle.moment=[0,1065,0];
  if(item.id.startsWith('concrete-frame-'))item.oracle.moment=[0,936,0];
  if(item.id==='grid3d-generic')item.oracle.moment=[0,27,-45];
  if(item.oracle.axialFrame?.P===50)item.oracle.moment=[-500,400,0];
  if(item.id.startsWith('selfweight-'))item.oracle.moment=[-682.25,545.8,0];
  if(item.id.startsWith('cases3d-'))item.oracle.moments={'case:D':[-500,400,0],'case:L':[0,288,-200],'combination:U':[-650,952,-300]};
}

const modalModel='三维单根悬臂柱，节点base=(0,0,0)、top=(0,0,3)，base六自由度固定，top仅约束uz和rz，其他自由度自由；构件column连接base至top，局部参考向量为全局X轴[1,0,0]。材料为用户提供的线弹性钢材，E=200000MPa，nu=0.3，rho=7850kg/m³；截面为用户明确给定的数值截面：A=0.02m²，Iy=0.0001m⁴，Iz=0.0002m⁴，J=0.00005m⁴，不要改为等代几何截面。top节点集中质量10吨，质量源仅为显式节点质量，X和Y两方向，禁止使用构件密度追加质量。不计自重，不施加静力荷载。上述输入全部已确认。';
cases.push(scenario('modal-generic','generic',`${modalModel}请用OpenSees动力引擎做前两阶线弹性模态分析，输出两阶频率和振型，不验算不生成报告。`,
  {nodes:2,members:1,dynamic:{method:'modal',frequencies:[.0001,.0002].map(I=>Math.sqrt(3*200000000*I/(27*10))/(2*Math.PI))}},'opensees-dynamic'));
const dt=.002,steps=100,ratio=.05,mass=10,k=3*200000000*.0001/27;
const wx=Math.sqrt(k/mass),wy=Math.sqrt(2*k/mass),alpha=2*ratio*wx*wy/(wx+wy),beta=2*ratio/(wx+wy),c=mass*alpha+beta*k;
const groundMotion=Array.from({length:steps+2},(_,i)=>.3*Math.sin(i*dt*9));
let u=0,v=0,a=0;const reference=[];
for(let i=0;i<steps;i++) {const up=u+dt*v+dt*dt*a/4,vp=v+dt*a/2;a=(-mass*groundMotion[i+1]-c*vp-k*up)/(mass+c*dt/2+k*dt*dt/4);u=up+dt*dt*a/4;v=vp+dt*a/2;reference.push({u,v,a});}
cases.push(scenario('time-history-generic','generic',`${modalModel}请用OpenSees动力引擎执行全局X向地震线弹性时程分析；初始静止，时间步0.002s、时长0.2s，Rayleigh阻尼比0.05由前两阶频率确定；使用常平均加速度Newmark算法。输入地面加速度单位m/s²，数据依次为${JSON.stringify(groundMotion)}。监测top及base六分量运动、column端力及base反力，运动为相对地面。输出结果，不验算不生成报告。`,
  {nodes:2,members:1,dynamic:{method:'time_history',reference,dt}},'opensees-dynamic'));
cases.push(scenario('beam-multi-turn','generic',simple,{total:[0,0,-10],moment:[0,30,0],nodes:3,beam:{L:6,P:10,E:206000,B:100,H:200}},os,{followUps:[
  {message:'将跨中集中力从10kN改为20kN，其余输入及工况ID保持不变。请重新分析反力、内力和位移，不验算不生成报告。',oracle:{total:[0,0,-20],moment:[0,60,0],beam:{L:6,P:20,E:206000,B:100,H:200}}},
  {message:'请为当前20kN荷载下的分析生成计算报告，报告必须对应当前模型和当前分析；不增加规范验算。',oracle:{total:[0,0,-20],moment:[0,60,0],beam:{L:6,P:20,E:206000,B:100,H:200}},reportRequested:true,preserveRun:true},
]}));

// Additional source inputs for native-grade identities. Q235B originals above
// remain unchanged, so their capability refusals cannot become solved cases.
for(const engine of ['pkpm-static','yjk-static']) for(const prefix of ['frame3d','cases3d']) {
  const original=cases.find(c=>c.id===`${prefix}-${engine.split('-')[0]}`);
  cases.push({...structuredClone(original),id:`${prefix}-q235-${engine.split('-')[0]}`,prompt:original.prompt.replace('材料Q235B','材料Q235')});
}
cases.push(scenario('beam-cases-specialist','beam',`${simple}将上述10kN跨中集中力明确放在恒载工况D；另设活载工况L，在同一跨中施加竖向向下20kN集中力；组合U=1.2D+1.6L。分别计算D、L和U，不要把两个工况的力合并。`,
  {nodes:3,totals:{'case:D':[0,0,-10],'case:L':[0,0,-20],'combination:U':[0,0,-44]},moments:{'case:D':[0,30,0],'case:L':[0,60,0],'combination:U':[0,132,0]}}));
const roof='三维两层一跨混凝土框架，X向一跨4m，Y向一跨5m，各层层高3m，柱脚全固定，全部梁柱刚接；C35，E=31500MPa、nu=0.2、rho=2500kg/m³，钢筋HRB400，梁柱均矩形300×300mm。不计自重、不考虑P-Delta、刚端或刚性楼板。恒载工况D：仅在z=6m的屋面、X=[0,4]和Y=[0,5]矩形区域施加竖向向下10kN/m²均布面荷载，第一层没有面荷载。单向板沿Y方向跨越，把面荷载传给两条X向屋面梁（Y=0和Y=5），不向Y梁传荷。所有物理输入与传荷方案已确认，仅用通用技能建模，进行线弹性静力分析，输出反力、内力及位移，不验算、不生成报告。';
cases.push(scenario('roof-area-multi-turn','generic',roof,{total:[0,0,-200],moment:[-500,400,0],nodes:12,members:16,extent:[4,5,6],roofTransfer:{width:4,height:5,pressure:10}},os,{fixtureRevision:2,revisionNote:'Clarify slab span versus support-beam direction; original support coordinates, all pressures, cases and numerical oracles are unchanged.',followUps:[
  {message:'只将屋面D工况面荷载从10kN/m²改为12kN/m²，第一层仍不受面荷载，传荷方向、几何、工况与源荷载ID保持不变。请更新并重新分析。',oracle:{total:[0,0,-240],moment:[-600,480,0],nodes:12,members:16,extent:[4,5,6],roofTransfer:{width:4,height:5,pressure:12}}},
  {message:'只将X向跨度由4m改为8m，屋面压力仍为12kN/m²，Y向跨度5m及其余输入不变；屋面受荷范围相应为X=[0,8]、Y=[0,5]，第一层仍不受面荷载。保留工况和荷载身份，重新分析。',oracle:{total:[0,0,-480],moment:[-1200,1920,0],nodes:12,members:16,extent:[8,5,6],roofTransfer:{width:8,height:5,pressure:12}}},
]}));
const pkpmGradeBoundary=structuredClone(cases.find(c=>c.id==='frame3d-pkpm'));
cases.push({...pkpmGradeBoundary,id:'q235b-pkpm-capability-feedback',expect:'refused',allowedCodes:['ENGINE_INPUT_UNSUPPORTED']});
const genericNative=structuredClone(cases.find(c=>c.id==='frame3d-generic-pkpm'));
cases.push({...genericNative,id:'frame3d-generic-q235-pkpm',prompt:genericNative.prompt.replace('材料Q235B','材料Q235')});
cases.push(scenario('existing-model-no-skills','generic',simple,{total:[0,0,-10],moment:[0,30,0],beam:{L:6,P:10,E:206000,B:100,H:200}},os,{followUps:[
  {message:'现在只查询已有这次分析的左支座竖向反力，并换算为N。此轮不启用任何结构技能，不建模、不修改、不重新分析、不报告，也不启用通用技能。',oracle:{total:[0,0,-10],moment:[0,30,0],beam:{L:6,P:10,E:206000,B:100,H:200}},
    preserveRun:true,policy:{skillIds:[],routing:{mode:'auto'}},skillIdsExpected:[],queryOnly:true},
]}));
// These original requests explicitly permit an honest unsupported response.
// Keep Q235B and every physical oracle unchanged; only this exact native-grade
// boundary is permitted. It is recorded as refused, never as a solved task.
for(const id of ['frame3d-pkpm','frame3d-generic-pkpm','cases3d-pkpm','q235b-pkpm-capability-feedback']) {
  const item=cases.find(c=>c.id===id);item.oracle.materialGrade='Q235B';
  item.allowCapabilityRefusal={code:'ENGINE_INPUT_UNSUPPORTED',capability:'native-material-grade'};
}
cases.push(scenario('nonlinear-capability-feedback','generic',simple.replace('仅做线弹性静力分析','本轮要求执行完整构件非线性分析，追踪塑性发展；不能用线弹性或简化模型替代。如果当前实现尚不支持，直接明确说明并停止，不必补问尚不能执行的非线性参数'),{},'opensees-nonlinear',{expect:'refused'}));
cases.push({id:'no-skills-general-chat',skill:null,engine:os,prompt:'请解释简支梁和两跨连续梁的区别。只作概念解释，不建模、不计算，也不要调用任何工具。',oracle:{},expect:'answered',policy:{skillIds:[],routing:{mode:'auto'}}});
cases.push(scenario('beam-clarification-resume','beam',`6m简支梁，左端铰支，右端沿X滚支。${steel}${controls}请分析反力、内力和挠度。`,
  {total:[0,0,-10],moment:[0,30,0],beam:{L:6,P:10,E:206000,B:100,H:200}},os,{answer:'外荷载是跨中竖直向下10kN集中力，其他输入保持不变。请继续完成反力、内力与位移分析。'}));
