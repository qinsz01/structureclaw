// Product-owned analytical references. No Bench data or production mechanics imports.
const coordinate = dimension => ({ semantics:'global-z-up', version:1, dimension,
  plane:dimension==='2d'?'xz':null, dof_order:['ux','uy','uz','rx','ry','rz'] });
const controls = { self_weight:false, rigid_floor:false, rigid_offsets:false, p_delta:false, construction_stage:false };
const E = 200000000, A = .02, Iy = .0001, Iz = .0002;
const baseModel = dimension => ({schema_version:'2.2.0',unit_system:'SI',coordinate_system:coordinate(dimension),
  materials:[{id:'steel',name:'Elastic steel',type:'steel',E:E/1000,nu:.3,rho:7850}],
  sections:[{id:'s',name:'Explicit numerical section',type:'custom',properties:{A,Iy,Iz,J:.00005}}],
  load_cases:[],load_combinations:[],analysis_control:{...controls}});
const beamMember = (id,nodes) => ({id,type:'beam',nodes,material:'steel',section:'s',design:{deflectionLimitN:300}});
const tolerance = {absolute:1e-8,relative:1e-7};
const quantity = (id,args,value) => ({id,args,value,tolerance});

function continuousBeam() {
  const model = {...baseModel('2d'),nodes:[
    {id:'A',x:0,y:0,z:0,restraints:[true,true,true,true,false,true]},
    {id:'B',x:4,y:0,z:0,restraints:[false,true,true,true,false,true]},
    {id:'C',x:8,y:0,z:0,restraints:[false,true,true,true,false,true]}],
    elements:[{...beamMember('AB',['A','B']),releases:{i:{ry:true}}},
      {...beamMember('BC',['B','C']),releases:{j:{ry:true}}}]};
  model.load_cases = [['D','dead',10],['L','live',4]].map(([id,type,q])=>({id,type,
    loads:['AB','BC'].map(element=>({id:`q-${element}`,type:'distributed',element,wz:-q}))}));
  model.load_combinations = [{id:'U',factors:{D:1.2,L:1.6}}];
  for (const member of model.elements) member.design.serviceability_result_keys=['case:D','case:L'];
  const quantities=[];
  for (const [key,q] of [['case:D',10],['case:L',4],['combination:U',18.4]]) {
    for (const [nodeId,value] of [['A',3*q*4/8],['B',5*q*4/4],['C',3*q*4/8]])
      quantities.push(quantity(`${key}-${nodeId}-R`,{resultKey:key,field:'reactions',nodeId,component:'fz',unit:'kN'},value));
    for (const x of [0,1.234,2,4]) {
      quantities.push(quantity(`${key}-AB-M-${x}`,{resultKey:key,elementId:'AB',positionM:x,component:'M2',unit:'kN.m'},-3*q*4*x/8+q*x*x/2));
      const slope = -(3*q*4/8*4**3/6-q*4**4/24)/(E*Iy*4);
      quantities.push(quantity(`${key}-AB-u-${x}`,{resultKey:key,elementId:'AB',positionM:x,component:'uz',unit:'mm'},
        ((3*q*4/8*x**3/6-q*x**4/24)/(E*Iy)+slope*x)*1000));
    }
  }
  return {id:'released-continuous-beam',model,analysis:{analysisType:'static',analysisSkillId:'opensees-static',
    loadCaseIds:['D','L'],loadCombinationIds:['U']},quantities,
    rejection:{resultKey:'case:D',field:'displacements',nodeId:'A',component:'ry',unit:'rad'},
    basis:'Equal two-span Euler-Bernoulli beam, q on both spans, external hinges, middle joint continuous; analytic three-moment solution',
    codeCheck:{sampledDeflectionMm:Object.fromEntries([['case:D',10],['case:L',4]].map(([key,q])=>[
      key,Math.max(...Array.from({length:81},(_,i)=>{
        const x=4*i/80;
        const slope=-(3*q*4/8*4**3/6-q*4**4/24)/(E*Iy*4);
        return Math.abs((3*q*4/8*x**3/6-q*x**4/24)/(E*Iy)+slope*x)*1000;
      }))]))}};
}

function spatialMixed() {
  const model = {...baseModel('3d'), nodes:[
    {id:'base',x:0,y:0,z:0,restraints:[true,true,true,true,true,true]},
    {id:'top',x:0,y:0,z:3,restraints:[false,false,true,false,false,true]},
    {id:'anchorX',x:-3,y:0,z:3,restraints:[true,true,true,false,false,false]},
    {id:'anchorY',x:0,y:-4,z:3,restraints:[true,true,true,false,false,false]}],
    elements:[{...beamMember('column',['base','top']),type:'column'},
      {...beamMember('braceX',['anchorX','top']),type:'brace'},
      {...beamMember('braceY',['anchorY','top']),type:'truss'}],
    load_cases:[{id:'D',type:'dead',loads:[{id:'F',type:'nodal',node:'top',fx:12,fy:8}]}]};
  const kx=3*E*Iy/27, ky=3*E*Iz/27, bx=E*A/3, by=E*A/4;
  const ux=12/(kx+bx), uy=8/(ky+by);
  return {id:'spatial-mixed-bracing',model,analysis:{analysisType:'static',analysisSkillId:'opensees-static',loadCaseIds:['D']},
    quantities:[
      quantity('top-x',{field:'displacements',nodeId:'top',component:'ux',unit:'mm'},1000*ux),
      quantity('top-y',{field:'displacements',nodeId:'top',component:'uy',unit:'mm'},1000*uy),
      quantity('top-ry',{field:'displacements',nodeId:'top',component:'ry',unit:'rad'},1.5*ux/3),
      quantity('top-rx',{field:'displacements',nodeId:'top',component:'rx',unit:'rad'},-1.5*uy/3),
      quantity('brace-N',{elementId:'braceX',positionM:1.234,component:'N',unit:'kN'},bx*ux),
      quantity('anchor-R',{field:'reactions',nodeId:'anchorX',component:'fx',unit:'N'},-1000*bx*ux),
      quantity('base-My',{field:'reactions',nodeId:'base',component:'my',unit:'kN.m'},-3*kx*ux)],
    rejection:{field:'displacements',nodeId:'anchorX',component:'rx',unit:'rad'},
    basis:'Two orthogonal cantilever bending springs in parallel with independent axial braces; EA/L and 3EI/L^3'};
}

function transient() {
  const model={...baseModel('3d'),nodes:[
    {id:'base',x:0,y:0,z:0,restraints:[true,true,true,true,true,true]},
    {id:'top',x:0,y:0,z:3,mass:10,restraints:[false,false,true,false,false,true]}],
    elements:[{...beamMember('column',['base','top']),type:'column'}],
    metadata:{elementReferenceVectors:{column:[1,0,0]}}};
  model.analysis_control={...controls,mass_source:'nodal',mass_directions:['x','y']};
  const dt=.002,steps=100,ratio=.05,mass=10,k=3*E*Iy/27;
  const wx=Math.sqrt(k/mass),wy=Math.sqrt(3*E*Iz/27/mass);
  const alpha=2*ratio*wx*wy/(wx+wy),beta=2*ratio/(wx+wy),c=mass*alpha+beta*k;
  const groundMotion=Array.from({length:steps+2},(_,i)=>.3*Math.sin(i*dt*9));
  let u=0,v=0,a=0; const reference=[];
  for (let i=0;i<steps;i++) {
    const up=u+dt*v+dt*dt*a/4,vp=v+dt*a/2;
    a=(-mass*groundMotion[i+1]-c*vp-k*up)/(mass+c*dt/2+k*dt*dt/4);
    u=up+dt*dt*a/4;v=vp+dt*a/2;reference.push({u,v,a});
  }
  const quantities=[];
  for (const timeIndex of [0,7,49,99]) {
    const r=reference[timeIndex];
    quantities.push(quantity(`u-${timeIndex}`,{timeIndex,field:'displacements',nodeId:'top',component:'ux',unit:'mm'},r.u*1000));
    quantities.push(quantity(`ry-${timeIndex}`,{timeIndex,field:'displacements',nodeId:'top',component:'ry',unit:'rad'},1.5*r.u/3));
    quantities.push(quantity(`v-${timeIndex}`,{timeIndex,field:'velocities',nodeId:'top',component:'ux',unit:'mm/s'},r.v*1000));
    quantities.push(quantity(`omega-${timeIndex}`,{timeIndex,field:'velocities',nodeId:'top',component:'ry',unit:'rad/s'},1.5*r.v/3));
    quantities.push(quantity(`a-${timeIndex}`,{timeIndex,field:'accelerations',nodeId:'top',component:'ux',unit:'mm/s2'},r.a*1000));
    quantities.push(quantity(`angular-a-${timeIndex}`,{timeIndex,field:'accelerations',nodeId:'top',component:'ry',unit:'rad/s2'},1.5*r.a/3));
    quantities.push(quantity(`R-${timeIndex}`,{timeIndex,field:'reactions',nodeId:'base',component:'fx',unit:'N'},-k*(r.u+beta*r.v)*1000));
    // ex=global Z, reference ez=global X => ey=ez cross ex=-global Y.
    // Global base My=-3*k*u, so the local M2 is +3*k*u.
    quantities.push(quantity(`M-${timeIndex}`,{timeIndex,field:'forces',elementId:'column',end:'n1',component:'M2',unit:'kN.m'},3*k*r.u));
  }
  return {id:'transient-nodes-endforces-reactions',model,analysis:{analysisType:'dynamic',analysisSkillId:'opensees-dynamic',
    method:'time_history',massSource:'nodal',massDirections:['x','y'],direction:'x',timeStep:dt,duration:dt*steps,
    dampingRatio:ratio,groundMotion,groundMotionUnit:'m/s2',monitorNodeIds:['top','base'],monitorElementIds:['column'],monitorSupportNodeIds:['base']},
    quantities,basis:'Independent scalar constant-average Newmark recurrence, analytic 3EI/L^3 and two-mode Rayleigh coefficients',
    referenceMetadata:{dt,steps,alpha,beta,relativeMotion:true,reactionDefinition:'-k*(u+beta*v)',endForceExcludesDamping:true,
      localAxes:{x:[0,0,1],y:[0,-1,0],z:[1,0,0]},localM2Definition:'+3*k*u; local y is opposite global Y'}};
}

function modes() {
  const model=transient().model;
  return {id:'modal-two-orthogonal-bending-modes',model,
    analysis:{analysisType:'dynamic',analysisSkillId:'opensees-dynamic',method:'modal',numModes:2,
      massSource:'nodal',massDirections:['x','y']},
    basis:'Independent condensed cantilever stiffness 3EI/L^3, 10 tonne tip mass, orthogonal bending; eigenvector sign is arbitrary',
    modeFrequencies:[Iy,Iz].map(inertia=>Math.sqrt(3*E*inertia/27/10)/(2*Math.PI)),
    quantities:[
      {...quantity('mode1-x',{field:'modal',modeNumber:1,nodeId:'top',component:'ux',unit:'1'},1),compareAbsolute:true},
      quantity('mode1-y',{field:'modal',modeNumber:1,nodeId:'top',component:'uy',unit:'1'},0),
      {...quantity('mode2-y',{field:'modal',modeNumber:2,nodeId:'top',component:'uy',unit:'1'},1),compareAbsolute:true},
      quantity('mode2-x',{field:'modal',modeNumber:2,nodeId:'top',component:'ux',unit:'1'},0)]};
}

export const scenarios = [continuousBeam(),spatialMixed(),transient(),modes()];
