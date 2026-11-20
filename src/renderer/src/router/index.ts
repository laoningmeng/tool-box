import { createRouter, createWebHashHistory } from 'vue-router'
import MainLayout from '@renderer/layouts/MainLayout.vue'

/**
 * 路由即导航：meta.title 用于面包屑 / 页面标题，meta.group 用于面包屑上级。
 * 使用 hash 模式，便于 file:// 打包后直接加载。
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: MainLayout,
      redirect: '/dashboard',
      children: [
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('@renderer/views/dashboard/index.vue'),
          meta: { title: '工作台', group: '概览' }
        },
        {
          path: 'resources',
          name: 'resources',
          component: () => import('@renderer/views/resources/index.vue'),
          meta: { title: '资源管理', group: '业务' }
        },
        {
          path: 'models',
          name: 'models',
          component: () => import('@renderer/views/models/index.vue'),
          meta: { title: '模型列表', group: '3D 模型管理' }
        },
        {
          path: 'models/config',
          name: 'model-config',
          component: () => import('@renderer/views/models/config.vue'),
          meta: { title: '配置管理', group: '3D 模型管理' }
        },
        {
          path: 'models/lab/:id',
          name: 'model-lab',
          component: () => import('@renderer/views/models/lab.vue'),
          meta: { title: '实验台', group: '3D 模型管理' }
        },
        {
          path: 'models/edit/:id',
          name: 'model-edit',
          component: () => import('@renderer/views/models/edit.vue'),
          meta: { title: '动作精修', group: '3D 模型管理' }
        },
        {
          path: 'workflow',
          name: 'workflow',
          component: () => import('@renderer/views/workflow/index.vue'),
          meta: { title: '流程列表', group: '工作流管理' }
        },
        {
          path: 'media',
          name: 'media',
          component: () => import('@renderer/views/media/index.vue'),
          meta: { title: '媒体库', group: '工作流管理' }
        },
        {
          path: 'workflow/run',
          name: 'workflow-run',
          component: () => import('@renderer/views/workflow/run.vue'),
          meta: { title: '执行流程', group: '工作流管理' }
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('@renderer/views/settings/index.vue'),
          meta: { title: '系统设置', group: '系统' }
        }
      ]
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@renderer/views/not-found.vue'),
      meta: { title: '页面不存在' }
    }
  ]
})

router.afterEach((to) => {
  const title = (to.meta?.title as string) ?? ''
  document.title = title ? `${title} · 穷哥们的工具箱` : '穷哥们的工具箱'
})

export default router
