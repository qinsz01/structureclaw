"""Independent legacy matrix oracle, only imported by deterministic regression tests.

Never used as an OpenSees fallback or to claim solver execution.
"""
import numpy as np
from typing import Dict, Any, List, Optional, Set, Tuple
import logging
import math
import re

logger = logging.getLogger(__name__)


from opensees_static_loads import StaticLoadContext


class ReferenceStaticAnalyzer(StaticLoadContext):
    def _get_coordinate_metadata(self) -> Dict[str, Any]:
        """Return cached model metadata dict for coordinate semantics lookups."""
        if self._coordinate_metadata is not None:
            return self._coordinate_metadata
        try:
            from coordinate_semantics import get_model_metadata

            model_dict = (
                self.model.model_dump(mode='python')
                if hasattr(self.model, 'model_dump')
                else self.model if isinstance(self.model, dict) else {}
            )
            self._coordinate_metadata = get_model_metadata(model_dict)
        except Exception:
            logger.debug('Could not extract coordinate metadata', exc_info=True)
            self._coordinate_metadata = {}
        return self._coordinate_metadata


    def run(self, parameters: Dict[str, Any]) -> Dict[str, Any]:
        logger.info("Starting static analysis")
        return self._run_simplified(parameters)


    def _raise_unstable_structure(self) -> None:
        raise ValueError(
            "Structure is unstable or insufficiently restrained; please check node restraints / boundary conditions."
        )


    def _axis_range(self, axis: str) -> float:
        values = [float(getattr(node, axis)) for node in self.model.nodes]
        if not values:
            return 0.0
        return max(values) - min(values)


    def _get_2d_plane_coordinates(self, node, plane: str) -> tuple[float, float]:
        if plane != 'xz':
            raise ValueError("Canonical 2-D analysis supports only the global X-Z plane")
        return float(node.x), float(node.z)


    def _run_simplified(self, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """Run the deterministic solver for the one declared dimension."""
        from coordinate_semantics import resolve_model_dimension

        batch_cases = parameters.get('batchCases', [])
        dimension = resolve_model_dimension(self.model)

        if self._can_run_2d_frame_solver():
            solver = (
                (lambda case_parameters: self._run_linear_2d_frame(case_parameters, 'xz'))
                if dimension == '2d'
                else self._run_linear_3d_frame
            )
        elif self._can_run_2d_truss_solver():
            solver = self._run_linear_2d_truss if dimension == '2d' else self._run_linear_3d_truss
        else:
            element_types = sorted({str(element.type) for element in self.model.elements})
            raise ValueError(
                "Deterministic static analysis supports homogeneous frame or truss models; "
                f"received element types {element_types}"
            )

        if batch_cases:
            return self._run_batch_cases(parameters, solver)
        return solver(parameters)


    def _can_run_2d_truss_solver(self) -> bool:
        """判断是否可用内置 2D truss 求解器。"""
        if not self.model.elements:
            return False
        return all(elem.type == 'truss' for elem in self.model.elements)


    def _can_run_2d_frame_solver(self) -> bool:
        """判断是否可用内置 2D frame 求解器。"""
        if not self.model.elements:
            return False
        return all(elem.type in {'beam', 'column'} for elem in self.model.elements)


    def _can_run_3d_frame_solver(self) -> bool:
        """判断是否可用内置 3D frame 求解器。"""
        if not self.model.elements:
            return False
        return all(elem.type in {'beam', 'column'} for elem in self.model.elements)


    def _requires_3d_frame_solver(self, parameters: Dict[str, Any]) -> bool:
        """
        判断 beam 模型是否需要 3D 求解路径。
        如果无法安全映射到 x-y / x-z 平面 frame，则走 3D。
        """
        return self._select_planar_frame_mode(parameters) is None


    def _select_planar_frame_mode(self, parameters: Dict[str, Any]) -> Optional[str]:
        """Select the declared solver dimension without guessing a plane."""
        if not self.model.elements or not all(elem.type in {'beam', 'column'} for elem in self.model.elements):
            return None
        from coordinate_semantics import resolve_model_dimension

        return 'xz' if resolve_model_dimension(self.model) == '2d' else None


    def _can_run_3d_truss_solver(self) -> bool:
        """判断是否可用内置 3D truss 求解器。"""
        if not self.model.elements:
            return False
        return all(elem.type == 'truss' for elem in self.model.elements)


    def _requires_3d_truss_solver(self) -> bool:
        """Use the one declared model dimension for truss routing."""
        from coordinate_semantics import resolve_model_dimension

        return resolve_model_dimension(self.model) == '3d'


    def _run_linear_3d_truss(self, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """
        3D truss 线弹性静力分析（DOF: ux, uy, uz）。
        """
        node_order = sorted(self.model.nodes, key=lambda n: n.id)
        node_index = {node.id: idx for idx, node in enumerate(node_order)}
        dof_count = len(node_order) * 3

        K = np.zeros((dof_count, dof_count), dtype=float)
        F = np.zeros(dof_count, dtype=float)

        for elem in self.model.elements:
            n1 = self.nodes[elem.nodes[0]]
            n2 = self.nodes[elem.nodes[1]]
            mat = self.materials[elem.material]
            sec = self.sections[elem.section]

            x1, y1, z1 = n1.x, n1.y, n1.z
            x2, y2, z2 = n2.x, n2.y, n2.z
            dx, dy, dz = x2 - x1, y2 - y1, z2 - z1
            L = float(np.sqrt(dx * dx + dy * dy + dz * dz))
            if L <= 0.0:
                raise ValueError(f"Element '{elem.id}' has zero length")

            A = float(sec.properties.get('A', 0.0))
            if A <= 0.0:
                raise ValueError(f"Element '{elem.id}' requires section area A > 0")

            E = self._effective_elastic_modulus(mat)
            l = dx / L
            m = dy / L
            n = dz / L
            k = (A * E) / L

            ke = k * np.array(
                [
                    [l * l, l * m, l * n, -l * l, -l * m, -l * n],
                    [l * m, m * m, m * n, -l * m, -m * m, -m * n],
                    [l * n, m * n, n * n, -l * n, -m * n, -n * n],
                    [-l * l, -l * m, -l * n, l * l, l * m, l * n],
                    [-l * m, -m * m, -m * n, l * m, m * m, m * n],
                    [-l * n, -m * n, -n * n, l * n, m * n, n * n],
                ],
                dtype=float,
            )

            i = node_index[n1.id] * 3
            j = node_index[n2.id] * 3
            dofs = [i, i + 1, i + 2, j, j + 1, j + 2]
            for r in range(6):
                for c_idx in range(6):
                    K[dofs[r], dofs[c_idx]] += ke[r, c_idx]

        for load in self._collect_nodal_loads(parameters):
            node_id = str(load.get('node', ''))
            if node_id not in node_index:
                continue
            i = node_index[node_id] * 3
            F[i] += float(load.get('fx', 0.0))
            F[i + 1] += float(load.get('fy', 0.0))
            F[i + 2] += float(load.get('fz', 0.0))

        fixed_dofs = set()
        for node in node_order:
            idx = node_index[node.id] * 3
            restraints = node.restraints or [False] * 6
            if restraints[0]:
                fixed_dofs.add(idx)
            if restraints[1]:
                fixed_dofs.add(idx + 1)
            if restraints[2]:
                fixed_dofs.add(idx + 2)

        free_dofs = [i for i in range(dof_count) if i not in fixed_dofs]
        if not free_dofs:
            raise ValueError("No free DOFs for solving")

        Kff = K[np.ix_(free_dofs, free_dofs)]
        Ff = F[free_dofs]
        try:
            Uf = np.linalg.solve(Kff, Ff)
        except np.linalg.LinAlgError as exc:
            try:
                self._raise_unstable_structure()
            except ValueError as unstable_error:
                raise unstable_error from exc

        U = np.zeros(dof_count, dtype=float)
        U[free_dofs] = Uf
        R = K @ U - F

        displacements = {}
        for node in node_order:
            i = node_index[node.id] * 3
            displacements[node.id] = {
                'ux': float(U[i]),
                'uy': float(U[i + 1]),
                'uz': float(U[i + 2]),
                'rx': 0.0,
                'ry': 0.0,
                'rz': 0.0,
            }

        forces = {}
        for elem in self.model.elements:
            n1 = self.nodes[elem.nodes[0]]
            n2 = self.nodes[elem.nodes[1]]
            mat = self.materials[elem.material]
            sec = self.sections[elem.section]
            x1, y1, z1 = n1.x, n1.y, n1.z
            x2, y2, z2 = n2.x, n2.y, n2.z
            dx, dy, dz = x2 - x1, y2 - y1, z2 - z1
            L = float(np.sqrt(dx * dx + dy * dy + dz * dz))
            A = float(sec.properties.get('A', 0.0))
            E = self._effective_elastic_modulus(mat)
            l = dx / L
            m = dy / L
            n = dz / L

            i = node_index[n1.id] * 3
            j = node_index[n2.id] * 3
            u1x, u1y, u1z = U[i], U[i + 1], U[i + 2]
            u2x, u2y, u2z = U[j], U[j + 1], U[j + 2]
            delta = l * (u2x - u1x) + m * (u2y - u1y) + n * (u2z - u1z)
            axial_force = (A * E / L) * delta
            forces[elem.id] = {
                'axial': float(axial_force),
                'stress': float(axial_force / A) if A > 0.0 else 0.0,
            }

        reactions = {}
        for node in node_order:
            i = node_index[node.id] * 3
            if i in fixed_dofs or (i + 1) in fixed_dofs or (i + 2) in fixed_dofs:
                reactions[node.id] = {
                    'fx': float(R[i]),
                    'fy': float(R[i + 1]),
                    'fz': float(R[i + 2]),
                }

        return self._attach_floor_load_transfer({
            'status': 'success',
            'analysisMode': 'linear_3d_truss',
            'displacements': displacements,
            'forces': forces,
            'reactions': reactions,
            'envelope': self._build_envelope(displacements, forces, reactions),
            'summary': self._generate_summary(displacements, forces),
        })


    def _run_linear_2d_truss(self, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """
        2D truss 线弹性静力分析（x-z 平面）
        """
        node_order = sorted(self.model.nodes, key=lambda n: n.id)
        node_index = {node.id: idx for idx, node in enumerate(node_order)}
        dof_count = len(node_order) * 2  # ux, uz

        K = np.zeros((dof_count, dof_count), dtype=float)
        F = np.zeros(dof_count, dtype=float)

        for elem in self.model.elements:
            n1 = self.nodes[elem.nodes[0]]
            n2 = self.nodes[elem.nodes[1]]
            mat = self.materials[elem.material]
            sec = self.sections[elem.section]

            x1, z1 = n1.x, n1.z
            x2, z2 = n2.x, n2.z
            dx, dz = x2 - x1, z2 - z1
            L = float(np.sqrt(dx * dx + dz * dz))
            if L <= 0.0:
                raise ValueError(f"Element '{elem.id}' has zero length")

            A = float(sec.properties.get('A', 0.0))
            if A <= 0.0:
                raise ValueError(f"Element '{elem.id}' requires section area A > 0")

            E = self._effective_elastic_modulus(mat)
            c = dx / L
            s = dz / L
            k = (A * E) / L

            ke = k * np.array(
                [
                    [c * c, c * s, -c * c, -c * s],
                    [c * s, s * s, -c * s, -s * s],
                    [-c * c, -c * s, c * c, c * s],
                    [-c * s, -s * s, c * s, s * s],
                ],
                dtype=float,
            )

            i = node_index[n1.id] * 2
            j = node_index[n2.id] * 2
            dofs = [i, i + 1, j, j + 1]
            for r in range(4):
                for c_idx in range(4):
                    K[dofs[r], dofs[c_idx]] += ke[r, c_idx]

        for load in self._collect_nodal_loads(parameters):
            node_id = str(load.get('node', ''))
            if node_id not in node_index:
                continue
            i = node_index[node_id] * 2
            F[i] += float(load.get('fx', 0.0))
            F[i + 1] += float(load.get('fz', 0.0))

        fixed_dofs = set()
        for node in node_order:
            idx = node_index[node.id] * 2
            restraints = node.restraints or [False] * 6
            if restraints[0]:
                fixed_dofs.add(idx)
            # z 向平移约束（常见 3D 第3个自由度）
            if restraints[2]:
                fixed_dofs.add(idx + 1)

        free_dofs = [i for i in range(dof_count) if i not in fixed_dofs]
        if not free_dofs:
            raise ValueError("No free DOFs for solving")

        Kff = K[np.ix_(free_dofs, free_dofs)]
        Ff = F[free_dofs]
        try:
            Uf = np.linalg.solve(Kff, Ff)
        except np.linalg.LinAlgError as exc:
            try:
                self._raise_unstable_structure()
            except ValueError as unstable_error:
                raise unstable_error from exc

        U = np.zeros(dof_count, dtype=float)
        U[free_dofs] = Uf

        R = K @ U - F

        displacements = {}
        for node in node_order:
            i = node_index[node.id] * 2
            displacements[node.id] = {
                'ux': float(U[i]),
                'uy': 0.0,
                'uz': float(U[i + 1]),
                'rx': 0.0,
                'ry': 0.0,
                'rz': 0.0,
            }

        forces = {}
        for elem in self.model.elements:
            n1 = self.nodes[elem.nodes[0]]
            n2 = self.nodes[elem.nodes[1]]
            mat = self.materials[elem.material]
            sec = self.sections[elem.section]

            x1, z1 = n1.x, n1.z
            x2, z2 = n2.x, n2.z
            dx, dz = x2 - x1, z2 - z1
            L = float(np.sqrt(dx * dx + dz * dz))
            A = float(sec.properties.get('A', 0.0))
            E = self._effective_elastic_modulus(mat)
            c = dx / L
            s = dz / L

            i = node_index[n1.id] * 2
            j = node_index[n2.id] * 2
            u1x, u1z = U[i], U[i + 1]
            u2x, u2z = U[j], U[j + 1]
            delta = c * (u2x - u1x) + s * (u2z - u1z)
            axial_force = (A * E / L) * delta
            forces[elem.id] = {
                'axial': float(axial_force),
                'stress': float(axial_force / A) if A > 0.0 else 0.0,
            }

        reactions = {}
        for node in node_order:
            i = node_index[node.id] * 2
            if i in fixed_dofs or (i + 1) in fixed_dofs:
                reactions[node.id] = {
                    'fx': float(R[i]),
                    'fz': float(R[i + 1]),
                }

        return self._attach_floor_load_transfer({
            'status': 'success',
            'analysisMode': 'linear_2d_truss',
            'displacements': displacements,
            'forces': forces,
            'reactions': reactions,
            'envelope': self._build_envelope(displacements, forces, reactions),
            'summary': self._generate_summary(displacements, forces),
        })


    def _run_linear_2d_frame(self, parameters: Dict[str, Any], plane: Optional[str] = None) -> Dict[str, Any]:
        """
        2D frame/beam 线弹性静力分析（global X-Z; DOF = ux, uz, ry）。
        """
        plane = plane or self._select_planar_frame_mode(parameters) or 'xz'
        node_order = sorted(self.model.nodes, key=lambda n: n.id)
        node_index = {node.id: idx for idx, node in enumerate(node_order)}
        dof_count = len(node_order) * 3

        K = np.zeros((dof_count, dof_count), dtype=float)
        F = np.zeros(dof_count, dtype=float)

        load_list = self._collect_nodal_loads(parameters)
        element_distributed_loads: Dict[str, List[Dict[str, Any]]] = {}
        for load in load_list:
            if str(load.get('type', '')) == 'distributed':
                elem_id = str(load.get('element', ''))
                if not elem_id:
                    continue
                element_distributed_loads.setdefault(elem_id, []).append(load)

        element_meta: Dict[str, Dict[str, Any]] = {}
        for elem in self.model.elements:
            n1 = self.nodes[elem.nodes[0]]
            n2 = self.nodes[elem.nodes[1]]
            mat = self.materials[elem.material]
            sec = self.sections[elem.section]

            x1, t1 = self._get_2d_plane_coordinates(n1, plane)
            x2, t2 = self._get_2d_plane_coordinates(n2, plane)
            dx, dt = x2 - x1, t2 - t1
            L = float(np.sqrt(dx * dx + dt * dt))
            if L <= 0.0:
                raise ValueError(f"Element '{elem.id}' has zero length")

            A = float(sec.properties.get('A', 0.0))
            if A <= 0.0:
                raise ValueError(f"Element '{elem.id}' requires section area A > 0")

            E = self._effective_elastic_modulus(mat)
            inertia_key = 'Iy'
            I = float(sec.properties.get(inertia_key, 0.0))
            if I <= 0.0:
                raise ValueError(f"Element '{elem.id}' requires section inertia {inertia_key} > 0")

            c = dx / L
            s = dt / L

            k_local = np.array(
                [
                    [E * A / L, 0, 0, -E * A / L, 0, 0],
                    [0, 12 * E * I / (L**3), 6 * E * I / (L**2), 0, -12 * E * I / (L**3), 6 * E * I / (L**2)],
                    [0, 6 * E * I / (L**2), 4 * E * I / L, 0, -6 * E * I / (L**2), 2 * E * I / L],
                    [-E * A / L, 0, 0, E * A / L, 0, 0],
                    [0, -12 * E * I / (L**3), -6 * E * I / (L**2), 0, 12 * E * I / (L**3), -6 * E * I / (L**2)],
                    [0, 6 * E * I / (L**2), 2 * E * I / L, 0, -6 * E * I / (L**2), 4 * E * I / L],
                ],
                dtype=float,
            )

            T = np.array(
                [
                    [c, s, 0, 0, 0, 0],
                    [-s, c, 0, 0, 0, 0],
                    [0, 0, 1, 0, 0, 0],
                    [0, 0, 0, c, s, 0],
                    [0, 0, 0, -s, c, 0],
                    [0, 0, 0, 0, 0, 1],
                ],
                dtype=float,
            )
            k_global = T.T @ k_local @ T

            i = node_index[n1.id] * 3
            j = node_index[n2.id] * 3
            dofs = [i, i + 1, i + 2, j, j + 1, j + 2]
            for r in range(6):
                for c_idx in range(6):
                    K[dofs[r], dofs[c_idx]] += k_global[r, c_idx]

            local_loads = [
                self._distributed_load_planar_components(load, elem)
                for load in element_distributed_loads.get(elem.id, [])
            ]
            qx = sum(item[0] for item in local_loads)
            q = sum(item[1] for item in local_loads)
            f_local_dist = np.zeros(6, dtype=float)
            if abs(qx) > 0.0 or abs(q) > 0.0:
                f_local_dist = np.array(
                    [qx * L / 2.0, q * L / 2.0, q * (L**2) / 12.0, qx * L / 2.0, q * L / 2.0, -q * (L**2) / 12.0],
                    dtype=float,
                )
                F[dofs] += T.T @ f_local_dist

            element_meta[elem.id] = {
                'dofs': dofs,
                'k_local': k_local,
                'transform': T,
                'f_local_dist': f_local_dist,
                'A': A,
            }

        for load in load_list:
            if str(load.get('type', '')) == 'distributed':
                continue
            node_id = str(load.get('node', ''))
            if node_id not in node_index:
                continue
            i = node_index[node_id] * 3
            F[i] += float(load.get('fx', 0.0))
            F[i + 1] += self._plane_transverse_force(load, plane)
            F[i + 2] += self._plane_bending_moment(load, plane)

        fixed_dofs = set()
        for node in node_order:
            idx = node_index[node.id] * 3
            restraints = node.restraints or [False] * 6
            if restraints[0]:
                fixed_dofs.add(idx)
            if restraints[2]:
                fixed_dofs.add(idx + 1)
            if restraints[4]:
                fixed_dofs.add(idx + 2)

        free_dofs = [i for i in range(dof_count) if i not in fixed_dofs]
        if not free_dofs:
            raise ValueError("No free DOFs for solving")

        Kff = K[np.ix_(free_dofs, free_dofs)]
        Ff = F[free_dofs]
        try:
            Uf = np.linalg.solve(Kff, Ff)
        except np.linalg.LinAlgError as exc:
            try:
                self._raise_unstable_structure()
            except ValueError as unstable_error:
                raise unstable_error from exc

        U = np.zeros(dof_count, dtype=float)
        U[free_dofs] = Uf
        R = K @ U - F

        displacements = {}
        for node in node_order:
            i = node_index[node.id] * 3
            displacements[node.id] = {
                'ux': float(U[i]),
                'uy': 0.0,
                'uz': float(U[i + 1]),
                'rx': 0.0,
                'ry': float(U[i + 2]),
                'rz': 0.0,
            }

        forces = {}
        for elem in self.model.elements:
            meta = element_meta[elem.id]
            dofs = meta['dofs']
            u_global = U[dofs]
            u_local = meta['transform'] @ u_global
            f_local = meta['k_local'] @ u_local - meta['f_local_dist']
            A = float(meta['A'])
            forces[elem.id] = {
                'referenceFrame': 'element-local',
                'n1': {'N': float(f_local[0]), 'V': float(f_local[1]), 'M': float(f_local[2])},
                'n2': {'N': float(f_local[3]), 'V': float(f_local[4]), 'M': float(f_local[5])},
                'axial': float(f_local[0]),
                'stress': float(f_local[0] / A) if A > 0.0 else 0.0,
            }

        reactions = {}
        for node in node_order:
            i = node_index[node.id] * 3
            if i in fixed_dofs or (i + 1) in fixed_dofs or (i + 2) in fixed_dofs:
                reactions[node.id] = {
                    'fx': float(R[i]),
                    'fz': float(R[i + 1]),
                    'my': float(R[i + 2]),
                }

        return self._attach_floor_load_transfer({
            'status': 'success',
            'analysisMode': 'linear_2d_frame',
            'plane': plane,
            'displacements': displacements,
            'forces': forces,
            'reactions': reactions,
            'envelope': self._build_envelope(displacements, forces, reactions),
            'summary': self._generate_summary(displacements, forces),
        })


    def _run_linear_3d_frame(self, parameters: Dict[str, Any]) -> Dict[str, Any]:
        """
        3D frame/beam 线弹性静力分析（DOF: ux, uy, uz, rx, ry, rz）。
        """
        node_order = sorted(self.model.nodes, key=lambda n: n.id)
        node_index = {node.id: idx for idx, node in enumerate(node_order)}
        dof_count = len(node_order) * 6

        K = np.zeros((dof_count, dof_count), dtype=float)
        F = np.zeros(dof_count, dtype=float)

        load_list = self._collect_nodal_loads(parameters)
        element_distributed_loads: Dict[str, List[Dict[str, Any]]] = {}
        for load in load_list:
            if str(load.get('type', '')) != 'distributed':
                continue
            elem_id = str(load.get('element', ''))
            if not elem_id:
                continue
            element_distributed_loads.setdefault(elem_id, []).append(load)

        element_meta: Dict[str, Dict[str, Any]] = {}
        for elem in self.model.elements:
            n1 = self.nodes[elem.nodes[0]]
            n2 = self.nodes[elem.nodes[1]]
            mat = self.materials[elem.material]
            sec = self.sections[elem.section]

            p1 = np.array([float(n1.x), float(n1.y), float(n1.z)], dtype=float)
            p2 = np.array([float(n2.x), float(n2.y), float(n2.z)], dtype=float)
            vec = p2 - p1
            L = float(np.linalg.norm(vec))
            if L <= 0.0:
                raise ValueError(f"Element '{elem.id}' has zero length")

            A = float(sec.properties.get('A', 0.0))
            Iy = float(sec.properties.get('Iy', 0.0))
            Iz = float(sec.properties.get('Iz', 0.0))
            J = float(sec.properties.get('J', 0.0))
            E = self._effective_elastic_modulus(mat)
            G = E / (2.0 * (1.0 + float(mat.nu)))

            if A <= 0.0 or Iy <= 0.0 or Iz <= 0.0 or J <= 0.0:
                raise ValueError(f"Element '{elem.id}' requires A/Iy/Iz/J > 0 for 3D frame solver")

            R = self._build_3d_rotation_matrix(vec / L, elem_id=elem.id)
            T = np.zeros((12, 12), dtype=float)
            T[0:3, 0:3] = R
            T[3:6, 3:6] = R
            T[6:9, 6:9] = R
            T[9:12, 9:12] = R

            k_local = self._build_3d_frame_local_stiffness(E, G, A, Iy, Iz, J, L)
            k_global = T.T @ k_local @ T

            i = node_index[n1.id] * 6
            j = node_index[n2.id] * 6
            dofs = [i, i + 1, i + 2, i + 3, i + 4, i + 5, j, j + 1, j + 2, j + 3, j + 4, j + 5]
            for r in range(12):
                for c_idx in range(12):
                    K[dofs[r], dofs[c_idx]] += k_global[r, c_idx]

            f_local_dist = np.zeros(12, dtype=float)
            for load in element_distributed_loads.get(elem.id, []):
                if load.get('distribution') == 'piecewise_linear':
                    for position, px, py, pz in self._piecewise_linear_element_point_loads(load, elem):
                        f_local_dist += self._build_3d_point_load_vector(px, py, pz, position, L)
                    continue
                wx, wy, wz = self._distributed_load_local_components(load, elem)
                f_local_dist += self._build_3d_uniform_load_vector(wx, wy, wz, L)
            if np.any(np.abs(f_local_dist) > 0.0):
                F[dofs] += T.T @ f_local_dist

            element_meta[elem.id] = {
                'dofs': dofs,
                'k_local': k_local,
                'transform': T,
                'f_local_dist': f_local_dist,
                'A': A,
                'local_axes': R,
            }

        for load in load_list:
            if str(load.get('type', '')) == 'distributed':
                continue
            node_id = str(load.get('node', ''))
            if node_id not in node_index:
                continue
            i = node_index[node_id] * 6
            F[i] += float(load.get('fx', 0.0))
            F[i + 1] += float(load.get('fy', 0.0))
            F[i + 2] += float(load.get('fz', 0.0))
            F[i + 3] += float(load.get('mx', load.get('momentX', 0.0)))
            F[i + 4] += float(load.get('my', load.get('momentY', 0.0)))
            F[i + 5] += float(load.get('mz', load.get('momentZ', 0.0)))

        fixed_dofs = set()
        for node in node_order:
            idx = node_index[node.id] * 6
            restraints = node.restraints or [False] * 6
            for k in range(6):
                if restraints[k]:
                    fixed_dofs.add(idx + k)

        free_dofs = [i for i in range(dof_count) if i not in fixed_dofs]
        if not free_dofs:
            raise ValueError("No free DOFs for solving")

        Kff = K[np.ix_(free_dofs, free_dofs)]
        Ff = F[free_dofs]
        try:
            Uf = np.linalg.solve(Kff, Ff)
        except np.linalg.LinAlgError as exc:
            try:
                self._raise_unstable_structure()
            except ValueError as unstable_error:
                raise unstable_error from exc

        U = np.zeros(dof_count, dtype=float)
        U[free_dofs] = Uf
        Rf = K @ U - F

        displacements = {}
        for node in node_order:
            i = node_index[node.id] * 6
            displacements[node.id] = {
                'ux': float(U[i]),
                'uy': float(U[i + 1]),
                'uz': float(U[i + 2]),
                'rx': float(U[i + 3]),
                'ry': float(U[i + 4]),
                'rz': float(U[i + 5]),
            }

        forces = {}
        for elem in self.model.elements:
            meta = element_meta[elem.id]
            dofs = meta['dofs']
            u_global = U[dofs]
            u_local = meta['transform'] @ u_global
            f_local = meta['k_local'] @ u_local - meta['f_local_dist']
            A = float(meta['A'])

            v1 = float(np.sqrt(f_local[1] ** 2 + f_local[2] ** 2))
            v2 = float(np.sqrt(f_local[7] ** 2 + f_local[8] ** 2))
            m1 = float(np.sqrt(f_local[4] ** 2 + f_local[5] ** 2))
            m2 = float(np.sqrt(f_local[10] ** 2 + f_local[11] ** 2))

            forces[elem.id] = {
                'referenceFrame': 'element-local',
                'localAxes': {
                    'x': meta['local_axes'][0].tolist(),
                    'y': meta['local_axes'][1].tolist(),
                    'z': meta['local_axes'][2].tolist(),
                },
                'n1': {
                    'N': float(f_local[0]),
                    'V': v1,
                    'M': m1,
                    'V2': float(f_local[1]),
                    'V3': float(f_local[2]),
                    'T': float(f_local[3]),
                    'M2': float(f_local[4]),
                    'M3': float(f_local[5]),
                },
                'n2': {
                    'N': float(f_local[6]),
                    'V': v2,
                    'M': m2,
                    'V2': float(f_local[7]),
                    'V3': float(f_local[8]),
                    'T': float(f_local[9]),
                    'M2': float(f_local[10]),
                    'M3': float(f_local[11]),
                },
                'axial': float(f_local[0]),
                'stress': float(f_local[0] / A) if A > 0.0 else 0.0,
            }

        reactions = {}
        for node in node_order:
            i = node_index[node.id] * 6
            if any((i + k) in fixed_dofs for k in range(6)):
                reactions[node.id] = {
                    'fx': float(Rf[i]),
                    'fy': float(Rf[i + 1]),
                    'fz': float(Rf[i + 2]),
                    'mx': float(Rf[i + 3]),
                    'my': float(Rf[i + 4]),
                    'mz': float(Rf[i + 5]),
                }

        return self._attach_floor_load_transfer({
            'status': 'success',
            'analysisMode': 'linear_3d_frame',
            'displacements': displacements,
            'forces': forces,
            'reactions': reactions,
            'envelope': self._build_envelope(displacements, forces, reactions),
            'summary': self._generate_summary(displacements, forces),
        })


    def _build_3d_rotation_matrix(self, ex: np.ndarray, elem_id: str = None) -> np.ndarray:
        """Build the single canonical element-local direction-cosine matrix."""
        if elem_id is None or elem_id not in self.elements:
            raise ValueError("A known element id is required to construct local axes")
        elem = self.elements[elem_id]
        start = self.nodes[elem.nodes[0]]
        end = self.nodes[elem.nodes[1]]

        from coordinate_semantics import build_element_local_axes, get_reference_vector

        reference = get_reference_vector(self._get_coordinate_metadata(), elem_id)
        axes = build_element_local_axes(
            [start.x, start.y, start.z],
            [end.x, end.y, end.z],
            reference,
            getattr(elem, 'rotation_angle', None),
        )
        expected_x = np.asarray(ex, dtype=float)
        expected_x /= float(np.linalg.norm(expected_x))
        if not np.allclose(axes[0], expected_x, atol=1e-10):
            raise ValueError(f"Element '{elem_id}' local X axis is inconsistent with its geometry")
        return axes


    def _distributed_load_local_components(self, load: Dict[str, Any], elem) -> Tuple[float, float, float]:
        """Return member-load components in the element-local X/Y/Z axes."""
        wx = self._to_float(load.get('wx', 0.0), 0.0)
        wy = self._to_float(load.get('wy', 0.0), 0.0)
        wz = self._to_float(load.get('wz', 0.0), 0.0)
        if load.get('reference_frame', 'global') == 'element-local':
            return wx, wy, wz

        start = self.nodes[elem.nodes[0]]
        end = self.nodes[elem.nodes[1]]
        vector = np.array([end.x - start.x, end.y - start.y, end.z - start.z], dtype=float)
        length = float(np.linalg.norm(vector))
        if length <= 0.0:
            raise ValueError(f"Element '{elem.id}' has zero length")
        axes = self._build_3d_rotation_matrix(vector / length, elem_id=elem.id)

        from coordinate_semantics import transform_global_vector_to_local

        return transform_global_vector_to_local([wx, wy, wz], axes)


    def _distributed_load_planar_components(self, load: Dict[str, Any], elem) -> Tuple[float, float]:
        """Return local axial/transverse loads for a canonical X-Z member."""
        wx = self._to_float(load.get('wx', 0.0), 0.0)
        wy = self._to_float(load.get('wy', 0.0), 0.0)
        wz = self._to_float(load.get('wz', 0.0), 0.0)
        if load.get('reference_frame', 'global') == 'element-local':
            if abs(wy) > 1e-12:
                raise ValueError(f"Element '{elem.id}' has an out-of-plane local wy load in a 2-D model")
            return wx, wz
        if abs(wy) > 1e-12:
            raise ValueError(f"Element '{elem.id}' has an out-of-plane global wy load in a 2-D model")

        start = self.nodes[elem.nodes[0]]
        end = self.nodes[elem.nodes[1]]
        from coordinate_semantics import planar_xz_local_components

        return planar_xz_local_components(
            [wx, wy, wz],
            [start.x, start.y, start.z],
            [end.x, end.y, end.z],
        )


    def _build_3d_frame_local_stiffness(
        self,
        E: float,
        G: float,
        A: float,
        Iy: float,
        Iz: float,
        J: float,
        L: float,
    ) -> np.ndarray:
        """构建 3D frame 局部刚度矩阵（Euler-Bernoulli）。"""
        k = np.zeros((12, 12), dtype=float)

        EA_L = E * A / L
        GJ_L = G * J / L
        EIy = E * Iy
        EIz = E * Iz

        # Axial
        k[0, 0] = EA_L
        k[0, 6] = -EA_L
        k[6, 0] = -EA_L
        k[6, 6] = EA_L

        # Torsion
        k[3, 3] = GJ_L
        k[3, 9] = -GJ_L
        k[9, 3] = -GJ_L
        k[9, 9] = GJ_L

        # Bending about local z (v-rz coupling, uses Iz)
        k[1, 1] = 12.0 * EIz / (L ** 3)
        k[1, 5] = 6.0 * EIz / (L ** 2)
        k[1, 7] = -12.0 * EIz / (L ** 3)
        k[1, 11] = 6.0 * EIz / (L ** 2)

        k[5, 1] = 6.0 * EIz / (L ** 2)
        k[5, 5] = 4.0 * EIz / L
        k[5, 7] = -6.0 * EIz / (L ** 2)
        k[5, 11] = 2.0 * EIz / L

        k[7, 1] = -12.0 * EIz / (L ** 3)
        k[7, 5] = -6.0 * EIz / (L ** 2)
        k[7, 7] = 12.0 * EIz / (L ** 3)
        k[7, 11] = -6.0 * EIz / (L ** 2)

        k[11, 1] = 6.0 * EIz / (L ** 2)
        k[11, 5] = 2.0 * EIz / L
        k[11, 7] = -6.0 * EIz / (L ** 2)
        k[11, 11] = 4.0 * EIz / L

        # Bending about local y (w-ry coupling, uses Iy)
        k[2, 2] = 12.0 * EIy / (L ** 3)
        k[2, 4] = -6.0 * EIy / (L ** 2)
        k[2, 8] = -12.0 * EIy / (L ** 3)
        k[2, 10] = -6.0 * EIy / (L ** 2)

        k[4, 2] = -6.0 * EIy / (L ** 2)
        k[4, 4] = 4.0 * EIy / L
        k[4, 8] = 6.0 * EIy / (L ** 2)
        k[4, 10] = 2.0 * EIy / L

        k[8, 2] = -12.0 * EIy / (L ** 3)
        k[8, 4] = 6.0 * EIy / (L ** 2)
        k[8, 8] = 12.0 * EIy / (L ** 3)
        k[8, 10] = 6.0 * EIy / (L ** 2)

        k[10, 2] = -6.0 * EIy / (L ** 2)
        k[10, 4] = 2.0 * EIy / L
        k[10, 8] = 6.0 * EIy / (L ** 2)
        k[10, 10] = 4.0 * EIy / L

        return k


    def _build_3d_uniform_load_vector(self, wx: float, wy: float, wz: float, L: float) -> np.ndarray:
        """Equivalent nodal load vector for local uniform member loads."""
        f = np.zeros(12, dtype=float)
        if abs(wx) > 0.0:
            f[0] += wx * L / 2.0
            f[6] += wx * L / 2.0
        if abs(wy) > 0.0:
            f[1] += wy * L / 2.0
            f[5] += wy * (L ** 2) / 12.0
            f[7] += wy * L / 2.0
            f[11] += -wy * (L ** 2) / 12.0
        if abs(wz) > 0.0:
            f[2] += wz * L / 2.0
            f[4] += -wz * (L ** 2) / 12.0
            f[8] += wz * L / 2.0
            f[10] += wz * (L ** 2) / 12.0
        return f


    def _build_3d_point_load_vector(
        self,
        px: float,
        py: float,
        pz: float,
        position: float,
        length: float,
    ) -> np.ndarray:
        """Consistent local nodal load vector for a beam point load."""
        xi = float(position)
        if xi < 0.0 or xi > 1.0:
            raise ValueError("Beam point-load position must be within [0, 1]")

        n1 = 1.0 - 3.0 * xi ** 2 + 2.0 * xi ** 3
        n2 = length * (xi - 2.0 * xi ** 2 + xi ** 3)
        n3 = 3.0 * xi ** 2 - 2.0 * xi ** 3
        n4 = length * (-xi ** 2 + xi ** 3)

        f = np.zeros(12, dtype=float)
        f[0] += px * (1.0 - xi)
        f[6] += px * xi
        f[1] += py * n1
        f[5] += py * n2
        f[7] += py * n3
        f[11] += py * n4
        f[2] += pz * n1
        f[4] += -pz * n2
        f[8] += pz * n3
        f[10] += -pz * n4
        return f


    def _piecewise_linear_element_point_loads(
        self,
        load: Dict[str, Any],
        elem: Any,
    ) -> List[Tuple[float, float, float, float]]:
        """Integrate a piecewise-linear member load with exact three-point quadrature."""
        raw_points = load.get('points')
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            raise ValueError("Piecewise-linear member loads require at least two points")

        points = sorted(raw_points, key=lambda point: self._to_float(point.get('position'), 0.0))
        positions = [self._to_float(point.get('position'), 0.0) for point in points]
        if positions[0] < 0.0 or positions[-1] > 1.0:
            raise ValueError("Piecewise-linear member-load positions must be within [0, 1]")

        start = self.nodes[elem.nodes[0]]
        end = self.nodes[elem.nodes[1]]
        length = float(np.linalg.norm(np.array([
            end.x - start.x,
            end.y - start.y,
            end.z - start.z,
        ], dtype=float)))
        if length <= 0.0:
            raise ValueError(f"Element '{elem.id}' has zero length")

        gauss_locations = (-math.sqrt(3.0 / 5.0), 0.0, math.sqrt(3.0 / 5.0))
        gauss_weights = (5.0 / 9.0, 8.0 / 9.0, 5.0 / 9.0)
        point_loads: List[Tuple[float, float, float, float]] = []

        for first, second in zip(points, points[1:]):
            first_position = self._to_float(first.get('position'), 0.0)
            second_position = self._to_float(second.get('position'), 0.0)
            if second_position <= first_position:
                raise ValueError("Piecewise-linear member-load positions must be strictly increasing")

            midpoint = 0.5 * (first_position + second_position)
            half_span = 0.5 * (second_position - first_position)
            for gauss_location, gauss_weight in zip(gauss_locations, gauss_weights):
                position = midpoint + half_span * gauss_location
                ratio = (position - first_position) / (second_position - first_position)
                interpolated = {
                    component: (
                        self._to_float(first.get(component, 0.0), 0.0) * (1.0 - ratio)
                        + self._to_float(second.get(component, 0.0), 0.0) * ratio
                    )
                    for component in ('wx', 'wy', 'wz')
                }
                local_components = self._distributed_load_local_components(
                    {
                        **interpolated,
                        'reference_frame': load.get('reference_frame', 'global'),
                    },
                    elem,
                )
                scale = gauss_weight * half_span * length
                point_loads.append((
                    position,
                    local_components[0] * scale,
                    local_components[1] * scale,
                    local_components[2] * scale,
                ))

        return point_loads


    def _effective_elastic_modulus(self, material) -> float:
        # Keep the simplified solver consistent with the OpenSees branch.
        return float(material.E) * 1000.0


    def _plane_transverse_force(self, load: Dict[str, Any], plane: str) -> float:
        if plane != 'xz':
            raise ValueError("Canonical 2-D nodal loads support only the global X-Z plane")
        out_of_plane = self._to_float(load.get('fy', 0.0), 0.0)
        if abs(out_of_plane) > 1e-12:
            raise ValueError("Global fy is out of plane for a canonical X-Z 2-D model")
        return self._to_float(load.get('fz', 0.0), 0.0)


    def _plane_bending_moment(self, load: Dict[str, Any], plane: str) -> float:
        if plane != 'xz':
            raise ValueError("Canonical 2-D nodal moments support only the global X-Z plane")
        mx = self._to_float(load.get('mx', 0.0), 0.0)
        mz = self._to_float(load.get('mz', 0.0), 0.0)
        if abs(mx) > 1e-12 or abs(mz) > 1e-12:
            raise ValueError("Only global my is active for a canonical X-Z 2-D model")
        return self._to_float(load.get('my', 0.0), 0.0)


    def _plane_distributed_load(self, load: Dict[str, Any], plane: str) -> float:
        if plane != 'xz':
            raise ValueError("Canonical 2-D member loads support only the global X-Z plane")
        if load.get('reference_frame', 'global') == 'element-local':
            out_of_plane = self._to_float(load.get('wy', 0.0), 0.0)
            if abs(out_of_plane) > 1e-12:
                raise ValueError("Local wy is out of plane for a 2-D frame element")
            return self._to_float(load.get('wz', 0.0), 0.0)
        out_of_plane = self._to_float(load.get('wy', 0.0), 0.0)
        if abs(out_of_plane) > 1e-12:
            raise ValueError("Global wy is out of plane for a canonical X-Z 2-D model")
        return self._to_float(load.get('wz', 0.0), 0.0)


    def run_nonlinear(self, parameters: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError(
            "Nonlinear analysis is not supported by the simplified engine"
        )


    def _get_beam_reference_vector(self, elem) -> List[float]:
        """Return an OpenSees vecxz that reproduces the canonical local axes."""
        return self._element_local_axes(elem)[2].tolist()


    def _element_local_axes(self, elem) -> np.ndarray:
        """Return canonical local X/Y/Z axes for an element."""
        start = self.nodes.get(elem.nodes[0])
        end = self.nodes.get(elem.nodes[1])
        if start is None or end is None:
            raise ValueError(f"Beam element '{elem.id}' references unknown nodes")

        axis = np.array([end.x - start.x, end.y - start.y, end.z - start.z], dtype=float)
        length = np.linalg.norm(axis)
        if length == 0:
            raise ValueError(f"Beam element '{elem.id}' has zero length")
        return self._build_3d_rotation_matrix(axis / length, elem_id=elem.id)
