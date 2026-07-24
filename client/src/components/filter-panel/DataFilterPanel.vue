<template>
  <div class="advanced-filter-panel">
    <div class="header">
      <h4>高级查询构建器</h4>
    </div>

    <div class="layer-selector">
      <label>分析图层：</label>
      <select v-model="mapState.filter.targetLayerId" @change="handleLayerSwitch" class="main-select">
        <option 
          v-for="layer in availableLayers"
          :key="layer.id" 
          :value="layer.id"
        >
          {{ layer.name }}
        </option>
      </select>
    </div>

    <div class="logic-toggle" v-if="currentSchema">
      <label><input type="radio" value="AND" v-model="mapState.filter.logicalOp" @change="applyFilter" /> 满足所有条件 (AND)</label>
      <label><input type="radio" value="OR" v-model="mapState.filter.logicalOp" @change="applyFilter" /> 满足任一条件 (OR)</label>
    </div>

    <div class="rules-container" v-if="currentSchema">
      <div v-for="(rule, index) in mapState.filter.rules" :key="rule.id" class="rule-row">
        
        <select v-model="rule.field" @change="handleFieldChange(rule)" class="field-select">
          <option v-for="(config, key) in currentSchema" :key="key" :value="key">
            {{ config.label || key }}
          </option>
        </select>

        <template v-if="currentSchema[rule.field]">
          <template v-if="currentSchema[rule.field].type === 'number'">
            <select v-model="rule.operator" @change="handleOperatorChange(rule)" class="op-select">
              <option value=">=">&ge; 大于等于</option>
              <option value="<=">&le; 小于等于</option>
              <option value="=">= 等于</option>
              <option value="between">介于</option>
            </select>
          </template>
          <template v-else-if="currentSchema[rule.field].type === 'string'">
            <div class="op-static">包含</div>
          </template>

          <div class="value-input-area">
            <input
              v-if="currentSchema[rule.field].type === 'number' && rule.operator !== 'between'"
              type="number" v-model="rule.value" @input="applyFilter" class="num-input"
            />
            <div v-if="currentSchema[rule.field].type === 'number' && rule.operator === 'between'" class="range-input">
              <input type="number" v-model="rule.value[0]" @input="applyFilter" placeholder="Min" />
              <input type="number" v-model="rule.value[1]" @input="applyFilter" placeholder="Max" />
            </div>
            <div v-if="currentSchema[rule.field].type === 'string'" class="multi-select">
              <label v-for="opt in currentSchema[rule.field].options" :key="opt" class="check-label">
                <input type="checkbox" :value="opt" v-model="rule.value" @change="applyFilter" />
                {{ opt }}
              </label>
            </div>
          </div>
        </template>

        <button class="remove-btn" @click="removeRule(index)">×</button>
      </div>
    </div>

    <button 
      class="add-rule-btn" 
      @click="addRule"
      v-if="currentSchema && Object.keys(currentSchema).length > 0"
    >
      + 添加筛选条件
    </button>
    <div v-else class="loading-hint">请等待图层数据加载完毕...</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { mapState, fieldSchema, getFlatLayers } from '../../store/mapState';
import { applyAttributeFilter } from '../../core/filter/AttributeFilter';

// 🌟 新增：利用降维提取器，无视文件夹层级，把所有二维矢量图层捞出来！
const availableLayers = computed(() => getFlatLayers(['geojson']));


// 计算属性：动态获取当前选中图层的数据字典
const currentSchema = computed(() => {
  return fieldSchema[mapState.filter.targetLayerId] || null;
});

// 切换图层时：清空以前的查询规则，重置视图
const handleLayerSwitch = () => {
  mapState.filter.rules = [];
  // 通知引擎取消所有过滤，恢复所有要素显示
  applyAttributeFilter(); 
};

// 执行过滤
const applyFilter = () => {
  applyAttributeFilter();
};

// 切换字段时，重置规则操作符和默认值
const handleFieldChange = (rule) => {
  const schema = currentSchema.value[rule.field];
  if (schema.type === 'number') {
    rule.operator = '>=';
    rule.value = 0;
  } else if (schema.type === 'string') {
    rule.operator = 'in';
    rule.value = []; 
  }
  applyFilter();
};

// 切换操作符时，智能转换单值和数组结构
const handleOperatorChange = (rule) => {
  if (rule.operator === 'between') {
    if (!Array.isArray(rule.value)) {
      rule.value = [0, 100]; 
    }
  } else {
    if (Array.isArray(rule.value)) {
      rule.value = Number(rule.value[0]) || 0;
    }
  }
  applyFilter(); 
};

const addRule = () => {
  const fields = Object.keys(currentSchema.value);
  if (fields.length === 0) return; 

  const firstField = fields[0]; 
  const newRule = { id: Date.now(), field: firstField, operator: '>=', value: 0 };
  
  handleFieldChange(newRule); 
  mapState.filter.rules.push(newRule);
};

const removeRule = (index) => {
  mapState.filter.rules.splice(index, 1);
  applyFilter();
};
</script>

<style scoped>
/* 褪去外壳：移除绝对定位、背景、阴影等。完全融入父级抽屉。 */
.advanced-filter-panel {
  width: 100%;
  color: white;
  display: flex;
  flex-direction: column;
}

.header { margin-bottom: 12px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
h4 { margin: 0; color: #38bdf8; font-size: 16px; }

.layer-selector { margin-bottom: 12px; font-size: 13px; display: flex; align-items: center; }
.main-select { flex: 1; max-width: 300px; margin-left: 8px; padding: 6px; background: #1e293b; color: white; border: 1px solid #475569; border-radius: 4px; outline: none; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.logic-toggle { font-size: 12px; display: flex; gap: 15px; margin-bottom: 12px; }

.rules-container { flex: 1; overflow-y: auto; margin-bottom: 12px; }
.rule-row { 
  display: flex; gap: 8px; align-items: flex-start; 
  background: rgba(255,255,255,0.05); padding: 8px; 
  border-radius: 6px; margin-bottom: 8px; 
}

select, input[type="number"] {
  background: rgba(0,0,0,0.3); border: 1px solid #334155; 
  color: white; padding: 4px; border-radius: 4px; font-size: 12px; outline: none;
}
.field-select { width: 90px; }
.op-select { width: 85px; }
.op-static { width: 85px; font-size: 12px; color: #94a3b8; padding-top: 4px; text-align: center; }

.value-input-area { flex: 1; display: flex; align-items: center; }
.num-input { width: 100%; box-sizing: border-box; }
.range-input { display: flex; align-items: center; gap: 4px; }
.range-input input { width: 45%; }

.multi-select { display: flex; flex-wrap: wrap; gap: 4px; }
.check-label { font-size: 12px; display: flex; align-items: center; gap: 2px; cursor: pointer; }

.remove-btn { 
  background: none; border: none; color: #ef4444; font-size: 18px; 
  cursor: pointer; padding: 0 4px; margin-top: -2px;
}
.remove-btn:hover { color: #f87171; }

.add-rule-btn {
  width: 100%; padding: 8px; background: rgba(56, 189, 248, 0.2);
  border: 1px dashed #38bdf8; color: #38bdf8; border-radius: 6px;
  cursor: pointer; font-weight: bold; transition: 0.2s;
}
.add-rule-btn:hover { background: rgba(56, 189, 248, 0.4); }
.loading-hint { font-size: 12px; color: #94a3b8; text-align: center; }
</style>